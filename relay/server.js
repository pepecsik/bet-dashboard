// Juice Bets live-score relay.
//
// What this replaces: index.html polling Apps Script's ?mode=fast endpoint
// on a timer to notice a score changed. Apps Script/Sheets stays the source
// of truth for everything else (bets, admin, ranking, stats) -- this only
// ever touches live match state.
//
// What it does: polls API-Football's live-fixtures endpoint on its own
// interval, and the instant a fixture's status/score differs from what it
// last saw, pushes just that change to every connected WebSocket client.
// Detecting "is this bet winning" / "did a column just turn green" stays
// entirely client-side in index.html, exactly like it already does for the
// sweat-pulse glow -- this relay only ever hands over raw match state.
//
// MOCK_MODE=1 runs against a small built-in fixture simulator instead of a
// real API-Football call, so this can be built and proven correct without
// an API key. Phase 1 (this file) is exactly that: prove a change reaches a
// connected client in well under a second. Wiring index.html to actually
// listen is Phase 2, done separately once this is trusted.

import { WebSocketServer } from "ws";
import http from "http";
import { combineState } from "./combine.js";
import { normalizeStatus } from "./normalizeStatus.js";
import { parseLiveStats, parseScorers } from "./parseStats.js";
import { shouldPollNow } from "./pollGate.js";
import { buildBetfairExport, formatBetfairExportText } from "./betfairExport.js";
import { addRequest, getNext, completeRequest, activePlayers, expireStaleClaims } from "./betfairQueue.js";
import { getMatchweekReadiness } from "./matchweekAuto.js";
import { computeWeeklySummary, SB_PLAYERS } from "./matchweekSummary.js";
import { detectBetEvents, emptyNotifiedState } from "./betNotificationEvents.js";
import {
  formatGoalMessage, formatBigWinMessage, formatOneMatchAwayMessage, formatOneGoalAwayMessage,
  formatOneGoalAwayAndLastLegMessage, formatBetDiedMessage, formatKickoff30MinMessage, formatDayBeforeMessage,
} from "./telegramMessages.js";
import { getEarliestKickoffGroup, shouldFireKickoff30Min, shouldFireDayBefore, everyoneHasPlaced } from "./kickoffReminders.js";

const PORT = parseInt(process.env.PORT || "8787", 10);
// Conservative default matches the Pro plan's safe budget (see the cost
// plan) -- drop this via env var once/if the Ultra upgrade goes through.
// Doesn't change any code, just the interval.
const POLL_MS = parseInt(process.env.POLL_MS || "10000", 10);
const MOCK_MODE = process.env.MOCK_MODE === "1";
const API_KEY = process.env.API_FOOTBALL_KEY || "";

// Used only by the manual /trigger page (MOCK_MODE) to actually write a fake
// match's state into the real sheet via Code.gs's adminSetTestMatchState,
// instead of just pinging connected clients -- same Apps Script Web App URL
// index.html/test.html already call.
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbwyH6V8PAyglEdBCOyGgVRhrVLFVLhdr4deKPUznv8Rk2I9tz3plm4O0kfgfxkGdskwFw/exec";
const TEST_MATCH_HOME_CODE = process.env.TEST_MATCH_HOME_CODE || "ABC";
const TEST_MATCH_AWAY_CODE = process.env.TEST_MATCH_AWAY_CODE || "DEF";
// Forces every /betfair-place-request to be a test job, regardless of what
// the caller sends -- a deploy-time safety switch so the REAL "Place bets on
// Betfair" button in the app (which has never had its own test-mode option;
// only acca's manual curl calls ever set test:true) can be exercised
// end-to-end without any risk of a real placement, without needing any app
// changes. Meant to be temporary: set this on Render while deliberately
// testing the real button flow, then unset it before any real matchweek.
const FORCE_BETFAIR_TEST_MODE = process.env.FORCE_BETFAIR_TEST_MODE === "1";

// Fast/slow split, Phase 2: a periodic, read-only pull of the week's bets
// from Code.gs's ?mode=bets (see scoring.js for what it's for). Runs
// regardless of MOCK_MODE -- bets always come from the real sheet, there's
// no "fake" version of this, and a GET here is harmless (no writes, doesn't
// touch API-Football's quota at all). Two minutes is plenty: bets don't
// change once a matchweek's locked in, this is just a safety-net refresh.
const BETS_SYNC_MS = parseInt(process.env.BETS_SYNC_MS || "120000", 10);

if (!MOCK_MODE && !API_KEY) {
  console.error("API_FOOTBALL_KEY is required outside MOCK_MODE. Set MOCK_MODE=1 to run against simulated data instead.");
  process.exit(1);
}

// fixtureId -> { status, score, elapsed, match }
const lastKnown = new Map();
const clients = new Set();

// What's already been notified for rules #4 (big win), #5A (one match
// away), #5B (one goal away), #6 (bet died) -- see betNotificationEvents.js
// for the full shape/semantics. In-memory, same accepted low-stakes
// restart risk as betfairQueue/alertedStuckMatch -- a relay restart mid-
// matchweek could in principle re-fire an already-sent notification once,
// which is just a repeated Telegram message, not a real-money risk like
// the betfair queue's own equivalent gap.
let betNotifiedState = emptyNotifiedState();

// Reads a request body, JSON.parse()s it, and calls onBody(parsedOrEmptyObject)
// -- malformed/missing JSON becomes {} rather than throwing, so a route
// using this can just check for the specific field(s) it needs.
function readJsonBody(req, onBody) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch (e) { /* leave {} */ }
    onBody(parsed);
  });
}

// The relay's own cached copy of this matchweek's bets -- what Phase 2
// exists to fill in. { headers, matches, fetchedAt } -- matches[] carries
// each match's fixtureId/homeCode/awayCode plus its bet cells, straight
// from Code.gs's buildBetsSnapshot(). Empty until the first successful
// sync; nothing reads this yet (that's Phase 3), it's just being proven to
// refresh correctly first.
// betSummary added for rules #4/#5A/#5B (Max Win per column, same row-1
// shape JB_CONFIG.maxWinRowIndex and index.html's own computeColumnStats
// already read off the full dashboard JSON) -- falls back to [] if
// Code.gs's ?mode=bets response doesn't carry it, same defensive pattern
// winCells already uses; a missing betSummary just means amounts show as
// €0.00 in those messages rather than crashing anything.
let betsCache = { headers: [], matches: [], winCells: [], betSummary: [], fetchedAt: 0 };

// Raw API-Football stat types/values per tracked fixture, refreshed on
// every poll (not just once, unlike the [stats-check] log lines) -- added
// so the actual xG question can be checked directly via /stats-debug at
// any time, instead of racing a log line that only fires once per fixture
// and is easy to miss in Render's log search/retention window.
let lastRawStats = {};

// The "place this person's bets on Betfair" request queue -- see
// betfairQueue.js for the state machine (one-at-a-time serialization,
// claim expiry). In-memory only, same as betsCache/lastKnown -- lost on a
// relay restart, which is an accepted, low-stakes edge case (see the
// comment on the /betfair-place-request/status route below).
let betfairQueue = [];

// Same TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID pattern as driver.js's own
// direct-notify functions, but set as env vars HERE on Render, separately
// from the Mac's .env -- the whole point of this one is that the relay is
// always running, unlike driver.js, which only exists for the duration of
// a single invocation and can't notice anything while nothing is claiming
// a job in the first place.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Confirmed live (2026-10-02): acca's own documented ~30s automatic cron
// poll against GET /betfair-place-request/next has never actually picked
// up a queued job unprompted, this whole testing cycle -- every single
// run needed an explicit manual nudge. A real queued bet then sat
// unclaimed for 3-4+ minutes with zero signal to Winston that anything
// was wrong, which is exactly the kind of silent gap that matters most
// right as real placement goes live. Can't fix the cron itself (that's
// OpenClaw's own scheduling, outside this repo entirely) -- but the relay
// CAN notice and say something, since it's the one thing that's always
// running, on its own setInterval (wired up at the bottom of this file)
// rather than depending on some other request to trigger a check --
// Winston queuing a job and then nobody touching the relay again is
// exactly the silent scenario this needs to catch, so it can't wait for a
// request that might never come.
const PENDING_ALERT_MS = parseInt(process.env.PENDING_ALERT_MS || "120000", 10); // 2 minutes
const alertedStalePending = new Set(); // player names already alerted for their CURRENT pending wait

// Shared by every direct-notify function below (stale pending bet, stuck
// matchweek, auto-matchweek result) -- one place that actually talks to
// Telegram, same silent-skip-when-unset behavior driver.js's own
// direct-notify functions already have.
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(JSON.stringify(data));
  } catch (err) {
    console.error("[relay] Telegram notify failed:", err.message);
  }
}

async function notifyStalePendingDirect(player, waitedMs) {
  const minutes = Math.round(waitedMs / 60000);
  return sendTelegram(`⚠️ ${player}'s bet has been queued for ~${minutes} min with nobody picking it up. The automatic pickup may not be running -- you may need to manually ask OpenClaw to run driver.js.`);
}

// Called on every queue-touching request (see server handler below) --
// looks for any entry that's been sitting in "pending" past
// PENDING_ALERT_MS and alerts once per player per stale wait (cleared the
// moment that player's entry moves off "pending", so a LATER wait can
// alert again rather than being silenced forever by the Set).
function checkStalePending() {
  const now = Date.now();
  for (const r of betfairQueue) {
    if (r.status === "pending" && now - r.requestedAt > PENDING_ALERT_MS) {
      if (!alertedStalePending.has(r.player)) {
        alertedStalePending.add(r.player);
        notifyStalePendingDirect(r.player, now - r.requestedAt).catch(() => {});
      }
    } else {
      alertedStalePending.delete(r.player);
    }
  }
}

// Screenshot hand-off store for the Betano driver -- confirmed live
// (2026-09-24): a bet-build screenshot handed to OpenClaw's Telegram
// message tool as either a local file path (blocked by its own
// directory allowlist) or an inline base64 buffer (silently truncated to
// ~10KB by the exec tool that produced it, well short of a real ~1MB
// screenshot's ~1.3MB base64 size) never actually reached Telegram
// intact. The relay is already a live, publicly reachable Node service
// (unlike the Mac driver.js runs on) -- serving the file over a real URL
// sidesteps both problems, since the message tool's own fetch mechanism
// is built to handle remote URLs as the primary case. In-memory only,
// same acceptable-loss-on-restart tradeoff as betfairQueue/betsCache --
// these are short-lived hand-off artifacts (superseded the moment the
// next bet is built), not something that needs to survive a restart.
// Capped at MAX_SCREENSHOTS entries, oldest evicted first, so a long
// Render uptime can't accumulate unbounded memory from repeated test runs.
const screenshotStore = new Map(); // filename -> { buffer, contentType, storedAt }
const MAX_SCREENSHOTS = 20;

const server = http.createServer((req, res) => {
  // CORS -- every route below is either public read data (bets, snapshot,
  // queue status) or an action gated by knowing a player's name, same
  // openness reasoning already documented route by route; nothing here
  // needs auth, so a wildcard origin is consistent with that, not a
  // widening of it. This was missing entirely until now, which is a real
  // gap, not a formality: index.html's own POST /betfair-place-request sets
  // an explicit Content-Type: application/json header, which triggers a
  // CORS preflight in a real cross-origin browser call (GitHub Pages ->
  // onrender.com) -- without this, that preflight has no answer and the
  // browser silently blocks the real request. Every test of this flow
  // until now went through either Playwright's page.route() (mocks the
  // network call entirely) or a direct curl (curl never enforces CORS --
  // it's a browser-only mechanism), so this never actually got exercised
  // by a real browser making a real cross-origin call.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  // Phase 2 visibility -- read-only, just the same bet picks anyone with
  // the app can already see, so this stays open (unlike /trigger) even
  // once MOCK_MODE is off. Useful for confirming the sync is actually
  // refreshing before anything is built on top of it.
  if (req.method === "GET" && req.url === "/bets-debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(betsCache, null, 2));
    return;
  }
  // Raw API-Football stat types/values per tracked fixture, refreshed every
  // poll -- see lastRawStats's own comment. Check this any time (mid-match
  // or after) to see exactly what API-Football is sending, instead of
  // digging through Render logs for a line that only fires once.
  if (req.method === "GET" && req.url === "/stats-debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastRawStats, null, 2));
    return;
  }
  // Phase 3 visibility -- the actual combined output (live score + bets +
  // computed colour) a connecting client would receive right now. Same
  // openness reasoning as /bets-debug.
  if (req.method === "GET" && req.url === "/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(computeFullState(), null, 2));
    return;
  }
  // This week's bets (2 per player, dynamic headers -- whatever the Sheet
  // currently has, no fixed count) translated into Betfair market/selection
  // wording --
  // the task input an external automation agent (or a human) needs to
  // build the accumulator on Betfair's Sportsbook. Same openness reasoning
  // as /bets-debug and /snapshot: it's just a differently-shaped view of
  // the same bet picks anyone with the app can already see, nothing new
  // exposed. ?format=text returns the plain-English recap instead of JSON
  // -- easier to hand straight to a person or paste into an agent prompt.
  if (req.method === "GET" && req.url.startsWith("/betfair-export")) {
    const exportData = buildBetfairExport(betsCache);
    const wantsText = new URL(req.url, "http://x").searchParams.get("format") === "text";
    if (wantsText) {
      // charset=utf-8 explicitly -- without it, the € in "stake €3.00" (a
      // multi-byte UTF-8 sequence) gets read back as mojibake by a client
      // that defaults to Latin-1, which is exactly what happened in testing.
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(formatBetfairExportText(exportData));
    } else {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(exportData, null, 2));
    }
    return;
  }
  // App -> acca handoff, poll-not-push (see acca's own reply on why: the
  // Gateway only speaks WebSocket RPC and can't be reached from Render
  // anyway, so acca polls this on a cron instead of the relay trying to
  // push to it). Forces an immediate fresh Sheet sync on request -- the
  // whole point of this button is placing real money on exactly what was
  // just confirmed, not whatever betsCache happened to have cached up to
  // 2 minutes ago.
  if (req.method === "POST" && req.url === "/betfair-place-request") {
    readJsonBody(req, async (body) => {
      const player = body && body.player;
      const test = FORCE_BETFAIR_TEST_MODE || !!(body && body.test);
      // See betfairQueue.js's addRequest() comment -- explicit opt-in only,
      // meaningless (ignored downstream) unless test is also true.
      const writeSheetOnTest = !!(body && body.writeSheetOnTest);
      if (!player) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing player" })); return; }
      try { await fetchBetsSnapshot(); } catch (e) { /* stale cache is still better than failing the request -- fetchBetsSnapshot already logs its own failure */ }
      betfairQueue = addRequest(betfairQueue, player, Date.now(), test, writeSheetOnTest);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "queued", player, test, writeSheetOnTest }));
    });
    return;
  }
  // acca's cron poll (~every 30s). Returns null whenever anything is
  // already claimed, not just when the queue is empty -- see
  // betfairQueue.js's getNext() for why that alone gives one-at-a-time
  // serialization across players with no locking logic needed on acca's
  // side.
  if (req.method === "GET" && req.url === "/betfair-place-request/next") {
    const job = getNext(betfairQueue, Date.now());
    if (!job) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ job: null })); return; }
    const exportData = buildBetfairExport(betsCache);
    // Confirmed live (2026-10-30): a claim that hard-stops mid-job without
    // ever calling /betfair-place-result with completeJob:true never clears
    // -- expireStaleClaims() kicks it back to pending after 15 min, and the
    // next pickup used to hand back ALL of this player's bets again,
    // including ones that had already been placed for real (bet 1 placed
    // twice in one real run). Filtering out anything already reflected in
    // winCells (see buildBetfairExport's alreadyPlaced) means a retry only
    // ever rebuilds what's actually still missing.
    const bets = exportData.bets.filter((b) => b.player === job.player && !b.alreadyPlaced);
    if (bets.length === 0) {
      // Every one of this player's bets already has a recorded WIN value --
      // nothing left to place (most likely this exact retry-after-hard-stop
      // scenario, where the earlier bet(s) had actually gone through fine).
      // Clear the claim now instead of handing driver.js an empty job.
      betfairQueue = completeRequest(betfairQueue, job.player);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ job: null, note: `${job.player}'s bets were already placed -- nothing left to do.` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ job: { player: job.player, requestedAt: job.requestedAt, test: !!job.test, writeSheetOnTest: !!job.writeSheetOnTest }, bets }, null, 2));
    return;
  }
  // Which players currently have an active (pending or claimed) request --
  // what the app polls to hide an avatar that's mid-flow, ahead of the
  // Sheet's own WIN value eventually taking that job over permanently once
  // placement actually completes (see startBettingProcess()'s existing
  // hide-on-winData check). In-memory only, so a relay restart mid-flow
  // can lose this -- an accepted, low-stakes edge case: the avatar could
  // briefly reappear, but the queue's busy-check (see getNext()) still
  // prevents two placement runs from ever actually overlapping.
  if (req.method === "GET" && req.url === "/betfair-place-request/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ active: activePlayers(betfairQueue, Date.now()) }));
    return;
  }
  // Full queue detail for the admin page's queue panel -- /status above only
  // ever gave a bare list of names (enough for the app to hide an avatar),
  // not enough to show an admin what's actually going on (whose job, what
  // state, how long it's been sitting, real or test). Read-only, same
  // openness reasoning as everything else here -- no admin auth, just like
  // adminSetWinValue and friends already have none of their own either.
  if (req.method === "GET" && req.url === "/betfair-place-request/queue") {
    expireStaleClaims(betfairQueue, Date.now());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      queue: betfairQueue.map((r) => ({
        player: r.player, status: r.status, test: !!r.test,
        requestedAt: r.requestedAt, claimedAt: r.claimedAt,
      })),
    }));
    return;
  }
  // Manual "unstick this" for the admin page -- same completeRequest() used
  // by the normal report-back once a job finishes, just callable directly
  // instead of requiring a curl relayed through chat every time a job needs
  // clearing
  // (see the real incidents this was built in response to). Clears
  // regardless of status (pending/claimed) -- there's
  // nothing to "undo" here, it only ever removes the relay's own queue
  // entry, never anything already placed or written to the Sheet.
  if (req.method === "POST" && req.url === "/betfair-place-request/clear") {
    readJsonBody(req, (body) => {
      const player = body && body.player;
      if (!player) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Missing player" })); return; }
      const before = betfairQueue.find((r) => r.player === player);
      betfairQueue = completeRequest(betfairQueue, player);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "cleared", player, wasPresent: !!before }));
    });
    return;
  }
  // acca calls this once both of a player's bets are placed -- reports the
  // Potential Return per bet back via the SAME adminSetWinValue action the
  // admin page's manual entry already uses (see Code.gs), so nothing new
  // was needed there. Also clears the queue claim, freeing the next
  // player's request to be picked up.
  //
  // test:true (a dry-run job -- see PLACEMENT_MANUAL.md's test branch)
  // skips every adminSetWinValue POST by default: a test job never actually
  // placed real bets, so writing its numbers into the Sheet as if they were
  // real would corrupt real WIN data with a fake number. `writeSheetOnTest`
  // (set on the original /betfair-place-request, see addRequest()'s own
  // comment) is the one deliberate exception -- a test job explicitly
  // opted in to prove the write mechanism itself actually works end to
  // end, still with no real bet ever placed. Every ordinary test job
  // leaves this false and behaves exactly as before. Still clears the
  // queue claim exactly the same as a real result would either way, so the
  // mechanical build/screenshot/recap/queue-clear flow can be proven end
  // to end regardless.
  if (req.method === "POST" && req.url === "/betfair-place-result") {
    readJsonBody(req, async (body) => {
      const player = body && body.player;
      const test = !!(body && body.test);
      const writeSheetOnTest = !!(body && body.writeSheetOnTest);
      const results = (body && body.results) || [];
      const shouldWrite = !test || writeSheetOnTest;
      if (!player || (shouldWrite && (!Array.isArray(results) || results.length === 0))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing player or results" }));
        return;
      }
      const outcomes = [];
      if (shouldWrite) {
        for (const r of results) {
          try {
            const resp = await fetch(APPS_SCRIPT_URL, {
              method: "POST",
              body: JSON.stringify({ action: "adminSetWinValue", colIdx: r.sheetColIdx, value: r.winAmount }),
            });
            const data = await resp.json();
            outcomes.push({ sheetColIdx: r.sheetColIdx, status: data.status || "error" });
          } catch (e) {
            outcomes.push({ sheetColIdx: r.sheetColIdx, status: "error", message: e.message });
          }
        }
      }
      // Confirmed live (2026-10-10): a real job's bet 1 placed for real
      // and reported here, but bet 2 then hard-stopped before the job
      // ever called this route a second (final) time -- since this used
      // to ALWAYS clear the queue claim, and driver.js only ever called
      // this once at the very end of a job, bet 1's real placement never
      // actually got reported at all (results was empty until the whole
      // job finished). driver.js now calls this once per bet, immediately
      // after each placement -- completeJob (default true, so any older
      // caller keeps today's behavior) lets it clear the claim only on
      // the bet that's actually last, not on every intermediate report.
      const completeJob = body.completeJob !== false;
      if (completeJob) betfairQueue = completeRequest(betfairQueue, player);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success", test, outcomes }));
    });
    return;
  }
  // driver.js calls this right after saving a screenshot locally, so both
  // the admin app and a Telegram send have a real, publicly reachable URL
  // to use instead of a local file path or a raw buffer -- see the
  // screenshotStore comment above for why. filename should be unique per
  // screenshot (driver.js already includes a timestamp); dataBase64 is the
  // raw PNG bytes, base64-encoded.
  if (req.method === "POST" && req.url === "/betano-screenshot") {
    readJsonBody(req, (body) => {
      const filename = body && body.filename;
      const dataBase64 = body && body.dataBase64;
      if (!filename || !dataBase64) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing filename or dataBase64" }));
        return;
      }
      let buffer;
      try { buffer = Buffer.from(dataBase64, "base64"); } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "dataBase64 isn't valid base64" }));
        return;
      }
      while (screenshotStore.size >= MAX_SCREENSHOTS) {
        screenshotStore.delete(screenshotStore.keys().next().value);
      }
      screenshotStore.set(filename, { buffer, contentType: (body && body.contentType) || "image/png", storedAt: Date.now() });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "stored", path: `/betano-screenshot/${encodeURIComponent(filename)}` }));
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/betano-screenshot/")) {
    const filename = decodeURIComponent(req.url.slice("/betano-screenshot/".length));
    const entry = screenshotStore.get(filename);
    if (!entry) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found (never uploaded, evicted, or relay restarted since)" })); return; }
    res.writeHead(200, { "Content-Type": entry.contentType });
    res.end(entry.buffer);
    return;
  }
  // Lets Code.gs (rules #1/#2, which fire from inside buildDashboard()/
  // saveWhatIfResultAuto(), not from anything in this relay) send through
  // the SAME bot/chat every other notification already uses, without
  // needing its own copy of TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID as a
  // separate Script Property -- one real secret, one place it's read from.
  if (req.method === "POST" && req.url === "/telegram-notify") {
    readJsonBody(req, async (body) => {
      const text = body && body.text;
      if (!text) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing text" }));
        return;
      }
      await sendTelegram(String(text));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success" }));
    });
    return;
  }
  // OpenClaw's standing knowledge log -- durable (Sheet-backed, not relay
  // memory, which would lose it on every restart/redeploy), so a self-fix
  // learned this week is still there next matchweek. Proxies to Code.gs the
  // same way /betfair-place-result already does for adminSetWinValue --
  // same APPS_SCRIPT_URL, same "fire a named action" shape, so there's one
  // consistent pattern for every write this relay forwards to the Sheet.
  if (req.method === "POST" && req.url === "/openclaw-knowledge") {
    readJsonBody(req, async (body) => {
      const { category, problem, fix, context } = body || {};
      if (!problem || !fix) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing problem or fix" }));
        return;
      }
      try {
        const resp = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          body: JSON.stringify({ action: "adminLogOpenClawKnowledge", category: category || "general", problem, fix, context: context || "" }),
        });
        const data = await resp.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // Read-before-build -- OpenClaw checks this before starting a placement
  // run, so a fix learned on, say, week 3 is actually available on week 9
  // instead of only living in that one session's own transcript.
  if (req.method === "GET" && req.url.startsWith("/openclaw-knowledge")) {
    const limit = parseInt(new URL(req.url, "http://x").searchParams.get("limit") || "20", 10);
    // The outer handler isn't async (see http.createServer above) -- an
    // IIFE here keeps this route's await local instead of needing every
    // route in the file converted.
    (async () => {
      try {
        const resp = await fetch(APPS_SCRIPT_URL, {
          method: "POST",
          body: JSON.stringify({ action: "adminGetOpenClawKnowledge", limit }),
        });
        const data = await resp.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }
  // Manual test trigger -- MOCK_MODE only, so this never becomes a stray
  // public control surface once real matches are actually being tracked.
  // Open /trigger on any browser (e.g. a computer) and click a button to
  // fire a fake event on demand, then check a connected client (e.g.
  // test.html on a phone) for the reaction -- no waiting on a timer, no
  // need for a real live match.
  if (MOCK_MODE && req.method === "GET" && req.url === "/trigger") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(TRIGGER_PAGE);
    return;
  }
  if (MOCK_MODE && req.method === "POST" && req.url === "/trigger") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      let action = null;
      try { action = JSON.parse(body || "{}").action; } catch (e) { /* leave null */ }
      const result = await applyTestAction(action);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("juice-bets live-score relay\n");
});
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  // A client that just connected shouldn't sit blank until the next actual
  // change -- hand it the full computed board right away.
  ws.send(JSON.stringify({ type: "state", ...computeFullState() }));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

// Debug only, temporary -- logged once per fixture (not once per process),
// the first time that fixture's response actually carries a non-empty
// statistics array. Settles a real open question (does API-Football send
// an "Expected Goals" stat at all for these fixtures, and does
// parseTeamStats() actually pick it up) with real evidence instead of
// guessing -- remove once that's confirmed one way or the other.
const loggedStatsFixtureIds = new Set();
const loggedEmptyStatsFixtureIds = new Set();

// Switched from ?live=all to ?ids=<this week's fixture IDs> -- the exact
// same query Code.gs's updateAllData() already uses and already gets full
// statistics/events/players back from. combine.js's own comment used to
// note live/cards data "isn't included" in the bulk live listing; rather
// than add a second, separate per-match call to get it, this just asks for
// the specific matches the relay already knows about (from betsCache, via
// Code.gs's ?mode=bets) via the endpoint already proven to carry the rich
// data -- same one bulk request either way, no extra API cost, and no
// longer dependent on a match happening to be in API-Football's global
// "currently live" listing (which also means a fixture that's NS or has
// just gone FT is reported correctly too, not just genuinely-live ones).
async function fetchTrackedFixtures() {
  if (MOCK_MODE) return mockFixtures();
  const ids = (betsCache.matches || []).map((m) => m.fixtureId).filter(Boolean);
  if (ids.length === 0) return []; // nothing to track yet (before the first bets sync, or between matchweeks)

  const res = await fetch(
    `https://v3.football.api-sports.io/fixtures?ids=${ids.join("-")}`,
    { headers: { "x-apisports-key": API_KEY } }
  );
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  const data = await res.json();
  const fixtures = data.response || [];

  fixtures.forEach((f) => {
    if (f.statistics && f.statistics.length) {
      const homeTypesNow = ((f.statistics[0] && f.statistics[0].statistics) || []).map((s) => `${s.type}=${s.value}`);
      const awayTypesNow = ((f.statistics[1] && f.statistics[1].statistics) || []).map((s) => `${s.type}=${s.value}`);
      const parsedNow = parseLiveStats(f.statistics);
      lastRawStats[f.fixture.id] = {
        match: `${f.teams.home.name} - ${f.teams.away.name}`,
        status: f.fixture.status.short,
        home: homeTypesNow,
        away: awayTypesNow,
        parsed: { h_xg: parsedNow && parsedNow.h_xg, a_xg: parsedNow && parsedNow.a_xg },
        updatedAt: Date.now(),
      };
    }
    if (loggedStatsFixtureIds.has(f.fixture.id)) return;
    if (!f.statistics || !f.statistics.length) {
      // A full weekend of matches went by with zero [stats-check] lines --
      // that was ambiguous: it could mean "polled every fixture, stats
      // just never populated" (an API-Football data-availability question)
      // OR "the poll never actually reached this fixture at all" (a gate/
      // config question) -- this log alone couldn't tell those apart,
      // since it only ever fired for the non-empty case. Logging once here
      // too (via its own dedup set, not `loggedStatsFixtureIds` -- that one
      // stays reserved for "real stats seen") closes that gap: seeing THIS
      // line at all proves the poll reached this fixture, even if
      // statistics stayed empty every time.
      if (!loggedEmptyStatsFixtureIds.has(f.fixture.id)) {
        loggedEmptyStatsFixtureIds.add(f.fixture.id);
        console.log(`[stats-check] fixture ${f.fixture.id} (${f.teams.home.name} - ${f.teams.away.name}) polled OK (status=${f.fixture.status.short}) but f.statistics is empty/missing so far`);
      }
      return;
    }
    loggedStatsFixtureIds.add(f.fixture.id);
    const homeTypes = ((f.statistics[0] && f.statistics[0].statistics) || []).map((s) => `${s.type}=${s.value}`);
    const awayTypes = ((f.statistics[1] && f.statistics[1].statistics) || []).map((s) => `${s.type}=${s.value}`);
    const parsed = parseLiveStats(f.statistics);
    console.log(`[stats-check] fixture ${f.fixture.id} (${f.teams.home.name} - ${f.teams.away.name}) raw home stats:`, homeTypes.join(" | "));
    console.log(`[stats-check] fixture ${f.fixture.id} raw away stats:`, awayTypes.join(" | "));
    console.log(`[stats-check] fixture ${f.fixture.id} parsed h_xg=${parsed && parsed.h_xg} a_xg=${parsed && parsed.a_xg}`);
  });

  return fixtures.map((f) => ({
    id: f.fixture.id,
    status: f.fixture.status.short, // raw API-Football code -- normalizeStatus() runs centrally in pollOnce()
    elapsed: f.fixture.status.elapsed,
    // API-Football freezes `elapsed` at 45/90 through stoppage time and
    // reports the announced added minutes here instead -- without this,
    // the displayed minute gets stuck at "90'" for the entire length of
    // injury time instead of ticking on to "90+3'" etc.
    extra: f.fixture.status.extra ?? null,
    score: `${f.goals.home ?? 0}-${f.goals.away ?? 0}`,
    match: `${f.teams.home.name} - ${f.teams.away.name}`,
    homeTeamId: f.teams.home.id,
    // null/empty on a match with nothing reported yet (NS, or a league API-
    // Football hasn't published stats for) -- degrades to "no live stats
    // yet" rather than asserting a fact about a match with nothing to show.
    stats: parseLiveStats(f.statistics),
    scorers: parseScorers(f.events, f.teams.home.id),
  }));
}

// -- Phase 1 mock, so this whole pipeline can be proven without a real key --
let mockTick = 0;
function mockFixtures() {
  mockTick++;
  const scored = mockTick >= 3; // simulate a goal landing a couple of polls in
  return [{
    id: 999001,
    status: "LIVE",
    elapsed: Math.min(mockTick * 2, 90),
    score: scored ? "1-0" : "0-0",
    match: "ARS - CHE",
  }];
}

// -- Manual test trigger (MOCK_MODE only) --
// Each button does TWO things: (1) actually writes the fake match's state
// into the real sheet, via Code.gs's adminSetTestMatchState -- the exact
// same DATA!D:F cells a real live match updates -- so the sheet's own
// conditional formatting recolors the bet pills for real, then (2) pings
// connected clients so they check right away instead of waiting out the
// normal poll. Only broadcasts once the sheet write actually succeeds --
// no point telling a client to go check if nothing really changed.
let testState = { status: "NS", score: "0-0" };

async function writeTestMatchToSheet(status, score) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify({
      action: "adminSetTestMatchState",
      homeCode: TEST_MATCH_HOME_CODE,
      awayCode: TEST_MATCH_AWAY_CODE,
      status, score,
    }),
  });
  return res.json();
}

async function applyTestAction(action) {
  const [homeStr, awayStr] = testState.score.split("-");
  let home = parseInt(homeStr, 10) || 0;
  let away = parseInt(awayStr, 10) || 0;
  // Once kicked off/scoring, a goal shouldn't reset the clock back to NS/FT
  // -- only actually resume play if the match wasn't already live.
  const stillLive = testState.status !== "NS" && testState.status !== "FT";
  switch (action) {
    case "kickoff": testState = { status: "1'", score: "0-0" }; break;
    case "goal_home": home += 1; testState = { status: stillLive ? testState.status : "1'", score: `${home}-${away}` }; break;
    case "goal_away": away += 1; testState = { status: stillLive ? testState.status : "1'", score: `${home}-${away}` }; break;
    case "ht": testState = { ...testState, status: "HT" }; break;
    case "2h": testState = { ...testState, status: "46'" }; break;
    case "ft": testState = { ...testState, status: "FT" }; break;
    case "reset": testState = { status: "NS", score: "0-0" }; break;
    default: return { status: "error", message: "Unrecognized action: " + action };
  }

  let sheetResult;
  try {
    sheetResult = await writeTestMatchToSheet(testState.status, testState.score);
  } catch (err) {
    return { status: "error", message: "Could not reach Apps Script: " + err.message, testState };
  }
  if (sheetResult.status !== "success") {
    return { status: "error", message: "Sheet write failed: " + (sheetResult.message || "unknown error"), testState };
  }

  const match = `${TEST_MATCH_HOME_CODE} - ${TEST_MATCH_AWAY_CODE}`;
  lastKnown.set(999001, { status: testState.status, score: testState.score, match });
  broadcast({ type: "update", fixture: { id: 999001, status: testState.status, score: testState.score, match }, detectedAt: Date.now() });

  return { status: "success", message: sheetResult.message, testState };
}

const TRIGGER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay test trigger</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f0c; color: #eaf1ec; padding: 24px 20px 40px; max-width: 420px; margin: 0 auto; }
  h1 { font-size: 17px; margin-bottom: 4px; }
  p { color: #8fa396; font-size: 13px; margin-top: 0; }
  button { display: block; width: 100%; padding: 14px; margin: 8px 0; border-radius: 8px; border: 1px solid #2a352d; background: #141b16; color: #eaf1ec; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:active { background: #1e2a22; }
  button.danger { border-color: #4a2323; color: #ff9b9b; }
  #state { font-family: monospace; font-size: 12px; color: #8fa396; margin-top: 18px; white-space: pre-wrap; background: #10150f; padding: 10px 12px; border-radius: 8px; border: 1px solid #222; }
  #state.error { color: #ff9b9b; border-color: #4a2323; }
</style></head>
<body>
  <h1>Juice Bets relay -- test trigger</h1>
  <p>Each button writes straight into your ${TEST_MATCH_HOME_CODE} - ${TEST_MATCH_AWAY_CODE} test row in the sheet, then pings connected clients. Check a connected client (e.g. test.html on your phone) right after clicking.</p>
  <button onclick="fire('kickoff')">Kickoff</button>
  <button onclick="fire('goal_home')">⚽ Goal -- ${TEST_MATCH_HOME_CODE}</button>
  <button onclick="fire('goal_away')">⚽ Goal -- ${TEST_MATCH_AWAY_CODE}</button>
  <button onclick="fire('ht')">Half Time</button>
  <button onclick="fire('2h')">Second Half</button>
  <button onclick="fire('ft')">Full Time</button>
  <button class="danger" onclick="fire('reset')">Reset</button>
  <div id="state">(no action fired yet)</div>
  <script>
    async function fire(action) {
      const stateEl = document.getElementById('state');
      stateEl.className = ''; stateEl.textContent = 'working…';
      const res = await fetch('/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json();
      stateEl.className = data.status === 'error' ? 'error' : '';
      stateEl.textContent = JSON.stringify(data, null, 2);
    }
  </script>
</body></html>`;

// Fast/slow split, Phase 3: the actual computed board, combining this
// relay's own live-score poll (lastKnown) with the cached bets (betsCache)
// via combine.js's pure combineState() -- see that file for the scoring
// logic and its one known gap (cards/goalscorer markets). This wrapper just
// supplies server.js's own module-level state to it.
function computeFullState() {
  return combineState(betsCache, lastKnown);
}

// Debug only, temporary -- see the [stats-check] logging in
// fetchTrackedFixtures(). That log only ever fires from INSIDE a poll that
// actually ran, so total silence from it was ambiguous between "polled
// every tick, stats just never showed up" and "the gate never let a poll
// through in the first place". Throttled to roughly once a minute (every
// 6th tick at the default 10s POLL_MS) instead of every tick, so it stays
// readable rather than flooding the log for however long nothing's live.
let gateBlockLogCounter = 0;

// Dispatch from a detectBetEvents() event to its rendered Telegram text --
// kept here as thin glue; the actual wording lives in telegramMessages.js
// (tested), this just routes each event type to the right formatter.
function renderBetEvent(event) {
  switch (event.type) {
    case "bigWin":
      return formatBigWinMessage(event.player, event.amount);
    case "oneMatchAway":
      return formatOneMatchAwayMessage(event.player, event.amount, event.match);
    case "oneGoalAway":
      return formatOneGoalAwayMessage(event.player, event.match, event.homeCode, event.awayCode, event.pick, event.score, event.minute);
    case "oneGoalAwayAndLastLeg":
      return formatOneGoalAwayAndLastLegMessage(event.player, event.amount, event.match, event.homeCode, event.awayCode, event.pick, event.score, event.minute);
    case "deaths":
      return formatBetDiedMessage(event.entries);
    default:
      return null;
  }
}

async function pollOnce() {
  // Gated -- see pollGate.js. MOCK_MODE always polls regardless (there's no
  // real quota to protect, and the manual /trigger page expects every tick
  // to actually run).
  if (!MOCK_MODE && !shouldPollNow(betsCache.matches, lastKnown, Date.now())) {
    gateBlockLogCounter++;
    if (gateBlockLogCounter % 6 === 1) console.log("[stats-check] poll gate blocked this tick (shouldPollNow=false) -- no fixture within 10min of kickoff or still live");
    return;
  }

  let fixtures;
  try {
    fixtures = await fetchTrackedFixtures();
  } catch (err) {
    console.error("poll failed:", err.message);
    return;
  }
  let anyChanged = false;
  const justFinished = [];
  for (const f of fixtures) {
    // Normalized here (once, centrally) so both mock and real fixtures go
    // through the same conversion, and lastKnown always holds the same
    // display/scoring-ready format ("58'", "FT", "NS", ...) the rest of the
    // app expects -- see normalizeStatus.js. Comparing on the normalized
    // value (not the raw code) also means the displayed minute now ticks
    // over roughly once a minute even without a score change, instead of
    // sitting frozen between actual events.
    const status = normalizeStatus(f.status, f.elapsed);
    const prev = lastKnown.get(f.id);
    const wasFT = !!prev && prev.status === "FT";
    // extra is compared separately from status -- status itself stays
    // frozen at e.g. "90'" for the whole of stoppage time (elapsed doesn't
    // move), so without this an added-time announcement (extra going from
    // null to 3) would never be seen as a change and never get broadcast.
    // stats/scorers are compared too now -- a stat ticking (a shot, a
    // corner, a possession swing) with no goal and no status change is
    // still a real update once stats are live-tracked, not a no-op.
    const statsChanged = JSON.stringify((prev && prev.stats) || null) !== JSON.stringify(f.stats);
    const scorersChanged = ((prev && prev.scorers) || "") !== (f.scorers || "");
    const changed = !prev || prev.status !== status || prev.score !== f.score || prev.extra !== f.extra || statsChanged || scorersChanged;
    // Rule #7 -- plain live score ticker, no bet context. Only a genuine
    // score change (not every status/stat tick that also counts as
    // "changed" above), and only once `prev` actually exists -- otherwise
    // the very first sighting of a fixture (prev undefined, score "0-0")
    // would misfire a false "GOAL" the moment it's first tracked.
    if (prev && prev.score !== f.score) {
      const goalMsg = formatGoalMessage(f.match, prev.score, f.score);
      if (goalMsg) sendTelegram(goalMsg).catch(() => {});
    }
    if (changed) {
      anyChanged = true;
      lastKnown.set(f.id, {
        status, score: f.score, elapsed: f.elapsed, extra: f.extra, match: f.match,
        stats: f.stats, scorers: f.scorers, homeTeamId: f.homeTeamId,
      });
    }
    // Recorded on the FIRST poll that sees FT, whether or not this counted
    // as "changed" above (a restart right after full time, for instance,
    // would already have status===FT on its very first sighting -- still
    // worth recording once). The Sheet write happens after the broadcast
    // below, off the hot path, so a slow or failing Apps Script call never
    // delays what connected clients see.
    if (!wasFT && status === "FT") {
      justFinished.push({ id: f.id, score: f.score, status, stats: f.stats, scorers: f.scorers });
    }
  }
  if (anyChanged) {
    const state = computeFullState();
    broadcast({ type: "state", ...state });
    // Rules #4/#5A/#5B/#6 -- detection only runs when something actually
    // changed this tick (computeFullState's own color state only ever
    // moves when a tracked match did), same gating broadcast() already
    // uses, so this never does redundant work on a quiet tick.
    const { events, notifiedState } = detectBetEvents(state.headers, state.matches, betsCache.betSummary, betNotifiedState);
    betNotifiedState = notifiedState;
    events.forEach((event) => {
      const msg = renderBetEvent(event);
      if (msg) sendTelegram(msg).catch(() => {});
    });
  }
  justFinished.forEach((fx) => {
    postFinalResult(fx).catch((err) => console.error("final-result POST failed for fixture", fx.id, ":", err.message));
  });
}

// The ONE durable write this relay ever makes into the Sheet -- fired once,
// the first time a tracked match is confirmed FT, instead of the old
// applyLiveScoreOverrides() writing continuously throughout play (which
// stops being necessary once nobody reads live state from the Sheet
// anymore -- see Code.gs's relayRecordFinalResult, delivered separately).
// Best-effort: if this fails, updateAllData()'s own periodic write (kept
// as a safety net) still eventually catches the same final score, so a
// relay hiccup at the exact moment of full time can't silently lose a
// result forever.
async function postFinalResult(fx) {
  const parts = String(fx.score || "0-0").split("-").map((n) => parseInt(n, 10));
  const homeGoals = Number.isFinite(parts[0]) ? parts[0] : 0;
  const awayGoals = Number.isFinite(parts[1]) ? parts[1] : 0;
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify({
      action: "relayRecordFinalResult",
      fixtureId: fx.id,
      homeGoals, awayGoals,
      status: fx.status,
      stats: fx.stats || null,
      scorers: fx.scorers || "",
    }),
  });
  const data = await res.json();
  if (data.status !== "success") throw new Error(data.message || "Code.gs rejected the write");
  console.log("final result recorded for fixture", fx.id);
}

async function fetchBetsSnapshot() {
  try {
    const res = await fetch(`${APPS_SCRIPT_URL}?mode=bets`);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      // Google Apps Script serves its own HTML error page (not JSON) for a
      // handful of distinct failure modes -- an uncaught exception inside
      // doGet, the daily/per-minute URL-fetch or execution quota, the
      // concurrent-executions-per-script limit, or (rarer) a deployment/
      // auth problem. `err.message` from a failed res.json() never said
      // which -- reading the body as text first and logging the actual
      // HTTP status plus a slice of what Google sent back (its error pages
      // carry a human-readable title/message) does, without having to dig
      // through the Apps Script Executions dashboard by hand every time.
      console.error(`bets sync failed: non-JSON response, HTTP ${res.status} ${res.statusText} -- body starts: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
      return;
    }
    if (!data || !Array.isArray(data.matches)) {
      console.error("bets sync: unexpected response shape", JSON.stringify(data).slice(0, 200));
      return;
    }
    betsCache = { headers: data.headers || [], matches: data.matches, winCells: data.winCells || [], betSummary: data.betSummary || [], fetchedAt: Date.now() };
    console.log(`bets snapshot refreshed: ${data.matches.length} match(es), ${(data.headers || []).length} column(s)`);
    broadcast({ type: "state", ...computeFullState() });
  } catch (err) {
    console.error("bets sync failed:", err.message);
  }
}

/* ===================== Auto "Start New Matchweek" ===================== */
// Runs the exact same server-side sequence as admin.html's manual "Start
// New Matchweek" button (Save Matchweek -> Clear & Set Date -> Clear Bets
// -> Get Fixture IDs -> Update All Data) the moment it's actually safe to,
// instead of waiting for Winston to notice and click it by hand.
//
//  - Never fires unless EVERY match in the current matchweek is FT (see
//    getMatchweekReadiness() in matchweekAuto.js). A manually-started new
//    matchweek (fresh NS fixtures) makes this false again on its own, so
//    an early manual start can never get run over by this -- there's
//    nothing left to structurally conflict with.
//  - Once all FT, fires 2 London calendar-days after the latest match's own
//    kickoff date (not the scheduled date, not clock time).
//  - A match sitting in a weird state (postponed/abandoned/etc, or still NS
//    well past its own kickoff) for more than 12h gets a one-off Telegram
//    alert instead of being guessed at -- the automation just keeps
//    waiting either way.
//  - Deliberately does NOT send the matchweek preview email -- that stays
//    a manual, confirmed, no-undo step, same as it already is today.
//  - AUTO_MATCHWEEK_ENABLED is an explicit opt-IN (env var, no redeploy
//    needed either way) -- stays off, same as if this code didn't exist,
//    until Winston sets it to "1" on Render once he's ready to trust it
//    with a real matchweek. Also hard-off under MOCK_MODE so a local/dev
//    run can never fire a real Apps Script write.
const AUTO_MATCHWEEK_ENABLED = process.env.AUTO_MATCHWEEK_ENABLED === "1" && !MOCK_MODE;
const MATCHWEEK_CHECK_MS = parseInt(process.env.MATCHWEEK_CHECK_MS || "3600000", 10); // hourly
const STUCK_ALERT_MS = 12 * 60 * 60 * 1000; // 12h, per Winston
const stuckMatchSince = new Map(); // match -> ms it was FIRST seen stuck
const alertedStuckMatch = new Set(); // matches already alerted for their CURRENT stuck spell
// The lastMatchDate this automation has already successfully handled --
// guards against firing twice for the same matchweek (e.g. two checks
// landing close together right at the boundary), with no persisted state
// needed across a restart: worst case after a restart is one extra,
// harmless re-check whose own "all FT" precondition is already gone the
// moment the sequence it ran actually worked.
let autoHandledLastMatchDate = null;

async function fetchDashboard() {
  const res = await fetch(APPS_SCRIPT_URL);
  return res.json();
}

async function postAdminAction(action, extra) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify(Object.assign({ action }, extra || {})),
  });
  return res.json();
}

// Mirrors admin.html's autoStepSaveMatchweek() -- computes each player's
// final points/money for the week fresh from the just-fetched data, same
// as the manual button does, rather than trusting anything cached.
async function autoSaveMatchweek(data) {
  const summary = computeWeeklySummary(data);
  const players = {};
  SB_PLAYERS.forEach((p) => { players[p] = summary[p]; });
  return postAdminAction("adminSaveMatchweek", { players });
}

// Same 5 steps as admin.html's runAutomation(), same order, same
// stop-at-first-failure -- just invoked here instead of from a browser
// button click.
async function runAutoMatchweekSequence(data) {
  let res = await autoSaveMatchweek(data);
  if (res.status === "error") return { ok: false, step: "Save Matchweek", message: res.message };

  const dateRes = await postAdminAction("adminSuggestNextDate", {});
  if (dateRes.status !== "success" || !dateRes.date) return { ok: false, step: "Suggest Next Date", message: dateRes.message || "no date returned" };
  const nextDate = dateRes.date;

  res = await postAdminAction("adminClearAndSetDate", { date: nextDate });
  if (res.status === "error") return { ok: false, step: "Clear & Set Date", message: res.message };

  res = await postAdminAction("adminClearBets", {});
  if (res.status === "error") return { ok: false, step: "Clear Bets", message: res.message };

  res = await postAdminAction("adminGetFixtureIds", {});
  if (res.status === "error") return { ok: false, step: "Get Fixture IDs", message: res.message };

  res = await postAdminAction("adminUpdateAllData", {});
  if (res.status === "error") return { ok: false, step: "Update All Data", message: res.message };

  return { ok: true, nextDate };
}

// The hourly check. Fetches fresh (never trusts a cache for this -- it's
// the one thing in this file that both reads money/score state AND
// triggers an irreversible write), flags/alerts any stuck match, and only
// ever calls runAutoMatchweekSequence() once readiness and the
// not-already-handled guard both agree.
async function checkAutoMatchweek() {
  if (!AUTO_MATCHWEEK_ENABLED) return;
  let data;
  try {
    data = await fetchDashboard();
  } catch (err) {
    console.error("[relay] matchweek auto-check: could not fetch dashboard:", err.message);
    return;
  }
  if (!data || !Array.isArray(data.matches)) return;

  const now = Date.now();
  const readiness = getMatchweekReadiness(data.matches, now);

  // Stuck-match alerting -- independent of whether we're otherwise ready,
  // since a stuck match is exactly what would be holding readiness back.
  const stuckSet = new Set(readiness.stuckMatches);
  for (const key of stuckMatchSince.keys()) {
    if (!stuckSet.has(key)) { stuckMatchSince.delete(key); alertedStuckMatch.delete(key); }
  }
  for (const match of readiness.stuckMatches) {
    if (!stuckMatchSince.has(match)) stuckMatchSince.set(match, now);
    const stuckForMs = now - stuckMatchSince.get(match);
    if (stuckForMs > STUCK_ALERT_MS && !alertedStuckMatch.has(match)) {
      alertedStuckMatch.add(match);
      sendTelegram(`⚠️ ${match} has been in an unusual state for 12h+ and is blocking the new matchweek from starting automatically. Needs a manual look.`).catch(() => {});
    }
  }

  if (!readiness.readyToStart) return;
  if (readiness.lastMatchDate === autoHandledLastMatchDate) return; // already handled this matchweek

  console.log(`[relay] matchweek auto-check: ready to start (last match ${readiness.lastMatchDate}) -- running the sequence`);
  const result = await runAutoMatchweekSequence(data);
  if (result.ok) {
    autoHandledLastMatchDate = readiness.lastMatchDate;
    sendTelegram(`✅ New matchweek started automatically (fixtures set for ${result.nextDate}). Check the bets grid and send the preview email when ready.`).catch(() => {});
  } else {
    sendTelegram(`🛑 Auto-starting the new matchweek failed at step "${result.step}": ${result.message}. Nothing further was run -- you'll need to pick this up manually in Admin.`).catch(() => {});
  }
}

// Rules #3A/#3B -- guarded by the kickoff timestamp itself rather than a
// date string: naturally resets every matchweek since the timestamp
// changes, no separate "new week" detection needed, same spirit as
// autoHandledLastMatchDate's own guard just above.
let kickoff30MinFiredForTs = null;
let dayBeforeFiredForTs = null;

function checkKickoffReminders() {
  const { ts, matches } = getEarliestKickoffGroup(betsCache.matches);
  if (ts === null) return;
  const now = Date.now();

  if (shouldFireKickoff30Min(ts, now) && kickoff30MinFiredForTs !== ts) {
    kickoff30MinFiredForTs = ts;
    const msg = formatKickoff30MinMessage(matches);
    if (msg) sendTelegram(msg).catch(() => {});
  }

  if (shouldFireDayBefore(ts, now) && dayBeforeFiredForTs !== ts) {
    if (everyoneHasPlaced(betsCache.headers, betsCache.winCells)) {
      // Skip condition met -- still mark as handled for this kickoff so it
      // doesn't re-check (and potentially fire late) every tick for the
      // rest of the day.
      dayBeforeFiredForTs = ts;
    } else {
      dayBeforeFiredForTs = ts;
      const msg = formatDayBeforeMessage();
      if (msg) sendTelegram(msg).catch(() => {});
    }
  }
}

setInterval(pollOnce, POLL_MS);
setInterval(fetchBetsSnapshot, BETS_SYNC_MS);
// Checked well under PENDING_ALERT_MS's own 2-minute default, so a stale
// job is actually caught close to the threshold rather than up to a whole
// extra interval late.
setInterval(checkStalePending, 30000);
setInterval(checkAutoMatchweek, MATCHWEEK_CHECK_MS);
// ~60s, same spirit as checkStalePending -- close enough to the true
// 30-min/24h marks without needing second-level precision (see
// kickoffReminders.js's own comment on the resulting firing window).
setInterval(checkKickoffReminders, 60000);
fetchBetsSnapshot(); // don't wait BETS_SYNC_MS for the first one
server.listen(PORT, () => {
  console.log(`relay listening on :${PORT} -- polling every ${POLL_MS}ms, mock=${MOCK_MODE}, bets sync every ${BETS_SYNC_MS}ms, FORCE_BETFAIR_TEST_MODE=${FORCE_BETFAIR_TEST_MODE}`);
});
