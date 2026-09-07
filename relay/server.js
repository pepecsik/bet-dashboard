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

// The relay's own cached copy of this matchweek's bets -- what Phase 2
// exists to fill in. { headers, matches, fetchedAt } -- matches[] carries
// each match's fixtureId/homeCode/awayCode plus its bet cells, straight
// from Code.gs's buildBetsSnapshot(). Empty until the first successful
// sync; nothing reads this yet (that's Phase 3), it's just being proven to
// refresh correctly first.
let betsCache = { headers: [], matches: [], winCells: [], fetchedAt: 0 };

const server = http.createServer((req, res) => {
  // Phase 2 visibility -- read-only, just the same bet picks anyone with
  // the app can already see, so this stays open (unlike /trigger) even
  // once MOCK_MODE is off. Useful for confirming the sync is actually
  // refreshing before anything is built on top of it.
  if (req.method === "GET" && req.url === "/bets-debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(betsCache, null, 2));
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

// Logged at most once per process lifetime -- a real confirmation, not
// hope, that this endpoint variant behaves the way fetchTrackedFixtures()'s
// own comment says it should.
let loggedStatsCheck = false;

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

  if (!loggedStatsCheck && fixtures.length > 0) {
    loggedStatsCheck = true;
    const sample = fixtures.find((f) => f.statistics && f.statistics.length) || fixtures[0];
    console.log(
      "[stats-check] ?ids= sample -- statistics present:", !!(sample.statistics && sample.statistics.length),
      "| events present:", !!(sample.events && sample.events.length)
    );
  }

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

async function pollOnce() {
  // Gated -- see pollGate.js. MOCK_MODE always polls regardless (there's no
  // real quota to protect, and the manual /trigger page expects every tick
  // to actually run).
  if (!MOCK_MODE && !shouldPollNow(betsCache.matches, lastKnown, Date.now())) return;

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
  if (anyChanged) broadcast({ type: "state", ...computeFullState() });
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
    const data = await res.json();
    if (!data || !Array.isArray(data.matches)) {
      console.error("bets sync: unexpected response shape", JSON.stringify(data).slice(0, 200));
      return;
    }
    betsCache = { headers: data.headers || [], matches: data.matches, winCells: data.winCells || [], fetchedAt: Date.now() };
    console.log(`bets snapshot refreshed: ${data.matches.length} match(es), ${(data.headers || []).length} column(s)`);
    broadcast({ type: "state", ...computeFullState() });
  } catch (err) {
    console.error("bets sync failed:", err.message);
  }
}

setInterval(pollOnce, POLL_MS);
setInterval(fetchBetsSnapshot, BETS_SYNC_MS);
fetchBetsSnapshot(); // don't wait BETS_SYNC_MS for the first one
server.listen(PORT, () => {
  console.log(`relay listening on :${PORT} -- polling every ${POLL_MS}ms, mock=${MOCK_MODE}, bets sync every ${BETS_SYNC_MS}ms`);
});
