// Drives a real Betfair Sportsbook bet build for whichever player is next
// in the relay's placement queue -- BOTH of their bets (Bet 1 then Bet 2,
// this product's actual two-bet-per-player structure), waiting for
// Winston's approval in the app between each one, same lifecycle Anne
// always had. Uses the ordered plan from ../betfairPlan.js and the page
// structure documented in ../SPORTSBOOK_RECON.md. Runs on the Mac (needs GB
// routing + a real Betfair login), invoked as `node driver.js` -- no player
// arg, it claims /betfair-place-request/next the same way Anne's own poll
// does, so there needs to be an actual pending request first (the app's
// "place bet" button, or POST /betfair-place-request manually).
//
// Connects to Anne/OpenClaw's own already-running "betfair" browser via CDP
// (chromium.connectOverCDP) instead of maintaining a separate profile.
// History: an earlier version launched its own independent, persistent
// Chrome profile -- abandoned after repeated real failures (2026-09-22): the
// NordVPN extension wouldn't reliably land on GB across restarts (landed in
// Brazil, then Portugal, on consecutive clean relaunches), and a fresh
// profile needs its own from-scratch login/extension/Cloudflare setup with
// none of that pain. Confirmed live that connectOverCDP against Anne's
// profile works and inherits its already-working GB routing + login, so
// this reuses it instead. Two real constraints that come with that:
// 1. Anne's browser process needs to actually be running (and logged in --
//    the login session itself doesn't survive a full process restart, only
//    cf_clearance and the VPN extension's own state do) for this to work at
//    all -- same constraint Anne's own workflow already has day to day.
// 2. Concurrency: this opens its OWN new tab in that browser rather than
//    touching whatever tab Anne might have open, but driver.js and Anne
//    still shouldn't both be actively driving the browser at the same
//    time -- not something this file can fully enforce on its own, see
//    ../STAGEHAND_PLAN.md's status section on Anne's narrowing role.
//
// Deterministic Playwright locators do essentially everything -- that's the
// whole point of this rewrite (see ../STAGEHAND_PLAN.md's "why"). Stagehand
// is wired in ONLY as a narrow, logged fallback for the exact step that
// fails, via withAiFallback() below -- never for open-ended planning. Every
// fallback use gets logged with the step it was needed for, so the actual
// "how often does this really need AI" rate can be checked against reality
// instead of assumed.
//
// IMPORTANT -- selector accuracy: the locators below were written from
// SPORTSBOOK_RECON.md's notes, not verified against the live DOM by me (no
// browser access from this sandbox). Expect the first real run to need
// selector fixes -- that's what the AI fallback + this file's own logging
// are for. Treat this as a solid first draft, not a finished, tested
// script.

import { chromium } from "playwright";
import { Stagehand } from "@browserbasehq/stagehand";
import { buildBetPlan } from "../betfairPlan.js";

const RELAY_URL = process.env.RELAY_URL || "https://bet-dashboard-relay.onrender.com";
// Anne/OpenClaw's browser must already be running with this CDP port open
// (confirmed live: `openclaw browser start`) before driver.js runs -- this
// script connects to it, it doesn't launch anything of its own.
const CDP_URL = process.env.BETFAIR_CDP_URL || "http://127.0.0.1:8092";
const EPL_FIXTURES_URL = "https://www.betfair.com/betting/football/english-premier-league/c-10932509";

// Per TOOLS.md's hard-stop rule (same one Anne follows) -- this script must
// never attempt to click through a Cloudflare Turnstile challenge. If one
// appears, stop immediately and let the caller (OpenClaw, wrapping this
// script) notify Winston, the same as any other hard stop.
class CloudflareChallengeError extends Error {
  constructor(url) { super(`Cloudflare Turnstile challenge at ${url} -- hard stop, needs manual clearing`); this.name = "CloudflareChallengeError"; }
}
class SameMatchConflictError extends Error {
  constructor(matches) { super(`Same match appears in multiple legs: ${matches.join(", ")} -- refusing to build a Bet Builder combo`); this.name = "SameMatchConflictError"; }
}

function assertNotChallenged(page) {
  const url = page.url();
  if (url.includes("cf-challenge") || url.includes("betfair.com/challenge")) throw new CloudflareChallengeError(url);
}

// Numeric-field delta between two stagehand.metrics snapshots. Written
// generically (whatever numeric keys exist, not a hardcoded field list) so
// it doesn't need updating if the field set changes between versions.
function metricsDelta(before, after) {
  const delta = {};
  Object.keys(after || {}).forEach((k) => {
    if (typeof after[k] === "number") delta[k] = after[k] - ((before && before[k]) || 0);
  });
  return delta;
}
function sumMetrics(deltas) {
  const total = {};
  deltas.forEach((d) => Object.keys(d).forEach((k) => { total[k] = (total[k] || 0) + d[k]; }));
  return total;
}

// Every AI fallback call gets recorded here (step description, timestamp,
// and its own real metrics delta) -- returned alongside the run's result so
// the caller can log/report real fallback-rate AND real cost data instead
// of the plan's original guess. Snapshotting metrics before/after each
// individual call (rather than trusting stagehand.metrics as a running
// total) is deliberate -- confirmed live (2026-09-22): the raw aggregate
// showed IDENTICAL token counts across three separate calls with different,
// differently-sized prompts, which isn't plausible for genuine independent
// measurements. Strong evidence this installed version's .metrics reflects
// only the most recent call, not an accumulated total -- so reading it once
// at the end of a multi-fallback run would silently undercount every call
// but the last. Per-call snapshotting sidesteps that regardless of which
// explanation turns out to be correct.
function makeFallbackLog() {
  const entries = [];
  return {
    entries,
    // page (driver.js's own real page, NOT stagehand.page) plus matchLabel
    // and selection are used to verify the fallback actually worked, not
    // just that .act() didn't throw. Confirmed live (2026-09-22): a run
    // with 7 fallback calls, all reporting success with real non-zero token
    // usage, hit a hard stop later because too few legs had actually
    // landed -- nothing had ever checked whether a fallback call's claimed
    // success matched reality, unlike the deterministic path's own
    // clickAndVerifyLeg. Checking the REAL page's betslip (not
    // stagehand.page) also incidentally covers the still-open question of
    // whether stagehand.page is even the same tab -- if the fallback acted
    // on a disconnected tab, the real page's betslip genuinely won't show
    // the leg, and this now catches that loudly instead of silently.
    async withAiFallback(page, stagehand, description, matchLabel, selection, deterministicFn) {
      try {
        return await deterministicFn();
      } catch (err) {
        if (err instanceof CloudflareChallengeError) throw err; // never paper over a hard stop
        const before = { ...stagehand.metrics };
        const result = await stagehand.page.act(description);
        const after = { ...stagehand.metrics };
        // Both the raw before/after snapshots AND the computed delta are
        // kept, not just the delta -- the delta assumes .metrics accumulates
        // (standard for most SDKs), but that's not actually confirmed for
        // this installed version, only suspected NOT to hold (see this
        // function's own comment). If .metrics instead resets per call, the
        // delta math here would be wrong (even negative), not just
        // approximate. Keeping the raw pair lets a real multi-fallback run's
        // actual sequence be inspected directly to settle which model is
        // true, rather than trusting either guess blind.
        entries.push({ description, deterministicError: err.message, at: new Date().toISOString(), metricsBefore: before, metricsAfter: after, metrics: metricsDelta(before, after) });

        const snapshot = await betslipSnapshot(page);
        if (!selectionAppearsIn(snapshot, selection)) {
          throw new Error(`AI fallback for ${matchLabel} ("${selection}") reported success but the leg never appeared in the betslip -- betslip shows: "${snapshot}"`);
        }
        return result;
      }
    },
  };
}

// Betfair displays some teams under a shorter/different name than
// betfairExport.js's own full official name (see TEAM_NAMES there) --
// confirmed live (2026-09-22): "Leeds United" appears on the fixtures list
// as plain "Leeds", which a full-name match against the link's accessible
// text can't find (a real hard stop on the first live test run, not a
// hypothetical). Only mapping what's actually been confirmed on the real
// site here, not guessing every club's Betfair-specific short form blind --
// extend this as more mismatches turn up in practice. Anything not listed
// falls through to the AI fallback, same as before.
const BETFAIR_DISPLAY_NAME_OVERRIDES = {
  "Leeds United": "Leeds",
  "Ipswich Town": "Ipswich",
  "Brighton & Hove Albion": "Brighton",
  "Manchester United": "Man Utd",
  "Tottenham Hotspur": "Tottenham",
  "Nottingham Forest": "Nottm Forest",
  "Coventry City": "Coventry",
  "Newcastle United": "Newcastle",
  "Hull City": "Hull",
  // "Man City" is inferred (consistent with the "Man Utd" pattern), not
  // explicitly re-confirmed from a garbled report -- verify this one
  // specifically against a real screenshot before trusting it blindly.
  "Manchester City": "Man City",
};
function betfairDisplayName(fullName) { return BETFAIR_DISPLAY_NAME_OVERRIDES[fullName] || fullName; }

// Scans the EPL fixtures list once and returns a map keyed by "Home vs Away"
// -> { href, priceButtons: Locator[3] } (home/draw/away, by position -- see
// SPORTSBOOK_RECON.md, buttons are price-only with no team name). Built
// once per run and reused for every list-pick AND to get each match-page
// href, rather than re-searching the list per leg or guessing a match-page
// URL slug.
async function buildFixtureIndex(page, matchesNeeded) {
  await page.goto(EPL_FIXTURES_URL, { waitUntil: "networkidle" });
  assertNotChallenged(page);

  const index = {};
  for (const { match, homeTeam, awayTeam } of matchesNeeded) {
    try {
      // The fixture link's accessible name is "<Home> <Away> <date/time>" --
      // matching on both team names anchors it even though the exact
      // date/time text isn't known ahead of time.
      const link = page.getByRole("link", { name: new RegExp(`${escapeRegex(betfairDisplayName(homeTeam))}.*${escapeRegex(betfairDisplayName(awayTeam))}`, "i") }).first();
      const href = await link.getAttribute("href");
      // The three price buttons (home/draw/away) are the row's next three
      // sibling buttons after the link, per the documented row structure.
      const row = link.locator("xpath=ancestor::*[self::tr or self::li or self::div][1]");
      const priceButtons = row.getByRole("button");
      index[match] = { href, priceButtons };
    } catch (err) {
      if (err instanceof CloudflareChallengeError) throw err;
      // Isolated per match, on purpose -- confirmed live (2026-09-22) this
      // used to throw and abort the WHOLE batch on a single unmapped name
      // (Leeds United, then Ipswich Town), silently losing every other
      // match's already-working lookup too. Left null here instead;
      // executeListPick/executeMatchPagePick's own AI fallback (see the
      // main loop below) is what's meant to recover this specific match --
      // this function's job is just to not take the rest down with it.
      index[match] = null;
    }
  }
  return index;
}

// Ground truth for "what does Betfair itself think is selected right now" --
// never trust a click's own success/no-error as proof it worked. Confirmed
// live (2026-09-22): "Betslip" renders as plain text, NOT a heading role --
// getByRole('heading', {name:'Betslip'}) times out every time and never
// resolves. getByText('Betslip', {exact:true}) is what actually works.
async function betslipSnapshot(page) {
  const label = page.getByText("Betslip", { exact: true }).first();
  return await label.evaluate((el) => {
    let node = el;
    for (let i = 0; i < 4 && node.parentElement; i++) node = node.parentElement;
    return node.innerText;
  }, undefined, { timeout: 5000 }).catch((e) => `<error: ${e.message}>`);
}

// Loose substring match, not exact -- the betslip's own rendering of a
// selection wasn't fully verified for every case (particularly "The Draw"
// -- unconfirmed whether it renders literally or as plain "Draw"), so this
// stays deliberately forgiving rather than risk false negatives on a
// genuinely-successful click. False positives are the bigger risk to avoid
// here, but a same-match false positive (this leg's own text appearing
// because SOME OTHER already-present leg happens to share a word) is
// vanishingly unlikely given team names/scorelines are specific.
function selectionAppearsIn(snapshot, selection) {
  if (selection === "The Draw") return snapshot.includes("Draw");
  return snapshot.includes(selection) || snapshot.includes(betfairDisplayName(selection));
}

// The actual root cause of the empty-slip bug (confirmed live, 2026-09-22,
// after ruling out row-scoping and a hydration race with direct evidence):
// Betfair's price buttons are TOGGLES -- clicking an already-selected one
// deselects it. clearBetslip()'s old .catch(() => {}) silently swallowed
// any failure to actually empty the slip, so a prior run's leftover legs
// would still be selected going in; this run's own "successful" clicks on
// those same buttons then toggled them all back OFF -- zero errors thrown
// anywhere, betslip left empty, nobody the wiser. Retrying-until-verified
// here handles this uniformly regardless of exact cause: if a click didn't
// produce the expected end state (this leg present), clicking again toggles
// it the other way, which is exactly the fix whether the first click was a
// genuine no-op or a toggle-off of stale state.
async function clickAndVerifyLeg(page, button, matchLabel, selection) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await button.click();
    assertNotChallenged(page);
    const snapshot = await betslipSnapshot(page);
    if (selectionAppearsIn(snapshot, selection)) return;
    if (attempt === 2) throw new Error(`Click for ${matchLabel} ("${selection}") didn't add a leg to the betslip after 2 attempts -- betslip shows: "${snapshot}"`);
  }
}

async function executeListPick(page, step, fixtureEntry) {
  if (!fixtureEntry) throw new Error(`No fixture-index entry for "${step.match}" -- link not found on the fixtures list`);
  const positionIdx = { home: 0, draw: 1, away: 2 }[step.position];
  const button = fixtureEntry.priceButtons.nth(positionIdx);
  await clickAndVerifyLeg(page, button, step.match, step.selection);
}

async function executeMatchPagePick(page, step, fixtureEntry) {
  if (!fixtureEntry || !fixtureEntry.href) throw new Error(`No captured href for "${step.match}" -- can't navigate without guessing the URL`);
  // Confirmed live (2026-09-22): fixtureEntry.href (a real getAttribute("href")
  // read, per SPORTSBOOK_RECON.md's documented format) has no leading slash --
  // naive string concatenation onto ".com" produced "betfair.comfootball/...",
  // a hard network failure (net::ERR_TUNNEL_CONNECTION_FAILED), not a
  // selector issue. Never exercised live before now -- every prior
  // successful test job's plan happened to be all Match Odds (list-pick)
  // legs, with zero match-page-pick legs in the mix, until this run's Bet 2
  // included some. Fixed with the real URL class (joins base+relative
  // correctly regardless of leading/trailing slashes) instead of another
  // manual string-concat guess -- deliberately keeping direct URL
  // navigation rather than switching to clicking the fixture's own link,
  // since SPORTSBOOK_RECON.md's own finding is that UI clicks (a
  // Competitions-tab click, specifically) were the one confirmed Cloudflare
  // trigger all night, while direct URL loads were clean every time.
  const base = new URL(fixtureEntry.href, "https://www.betfair.com").toString();
  const url = step.tab === "all-markets" ? `${base}?tab=all-markets` : base;
  await page.goto(url, { waitUntil: "networkidle" });
  assertNotChallenged(page);

  if (step.market === "Correct Score") {
    // Collapsed accordion by default -- expand it first.
    await page.getByRole("button", { name: "Correct Score" }).click();
    const scoreline = step.selection.replace("-", " - "); // "2-1" -> "2 - 1" per the recon file's exact label format
    const label = page.getByText(scoreline, { exact: true });
    // The price button is the label's next sibling in the same row, not the
    // label itself -- clicking the label wasn't confirmed to add a leg.
    const priceButton = label.locator("xpath=following-sibling::button[1]");
    await clickAndVerifyLeg(page, priceButton, step.match, step.selection);
    return;
  }

  if (step.market.startsWith("Over/Under")) {
    const m = step.selection.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`Unrecognized Over/Under selection format: "${step.selection}"`);
    const [, direction, line] = m;
    const lineLabel = page.getByText(`${line} Goals`, { exact: true });
    if ((await lineLabel.count()) === 0) {
      // Higher goal lines are hidden behind "Show More" by default.
      // Confirmed live (2026-09-22): an unscoped page-wide
      // getByRole("button", {name:"Show More"}) matches 3 separate buttons
      // (one per market card on the page) -- that ambiguity is what was
      // causing a 30s hang (Playwright's actionability retry against an
      // unstable/ambiguous match set), not a clean strict-mode throw.
      // Anchored to the "Over / Under Goals" card's own heading instead,
      // same pattern as every other selector fix tonight -- verified via
      // bounding-box match against the correct one of the three.
      await page.getByRole("button", { name: "Over / Under Goals" }).locator('xpath=following::button[text()="Show More"][1]').click();
    }
    const columnIdx = direction === "Over" ? 0 : 1; // Over column, then Under column, per the recon file
    const priceButton = lineLabel.locator("xpath=following::button").nth(columnIdx);
    await clickAndVerifyLeg(page, priceButton, step.match, step.selection);
    return;
  }

  throw new Error(`Unhandled market "${step.market}" in executeMatchPagePick`);
}

// Betfair's betslip silently switches into "Bet Builder" mode for same-match
// legs (see SPORTSBOOK_RECON.md) -- this can't happen with this product's
// data shape (checked upstream by betfairPlan.js's own conflict check), but
// verifying the actual on-page state is the only way to be sure Betfair
// agrees, rather than trusting an assumption about its own behavior.
async function verifyMultiples(page) {
  const betBuilderTab = page.getByRole("tab", { name: "Bet Builder", selected: true });
  if (await betBuilderTab.count()) {
    throw new SameMatchConflictError(["betslip unexpectedly in Bet Builder mode -- see full page state for which legs"]);
  }
}

// Confirmed live (2026-09-22): driver.js was never filling the stake at
// all, which is why every "successful" build showed Potential Return as £0
// -- nothing to do with the legs, just a missing step. First attempt used a
// bare .first() on aria-label="Stake" and was ALSO wrong, confirmed live
// (2026-09-22): the Singles tab's own Stake boxes coexist in the accessible
// DOM even while Multiples is the visually active tab (7 boxes counted
// with Multiples active, more than Multiples' own 5), and Singles' boxes
// come first in document order -- so .first() silently filled Arsenal's
// single-leg stake, not the 6-fold's. Fixed by anchoring to the "Additional
// Multiples" heading instead: the Stake textbox immediately preceding it in
// document order is confirmed (bounding-box-verified against the visible
// box) to always be the primary combined-bet's own field, not any hashed
// CSS class or the fold-count text (which varies: "6 Fold" for 6 legs,
// different counts otherwise). Assumes 2+ legs, so "Additional Multiples"
// exists at all -- true for every accumulator this project builds.
async function fillStake(page, stake) {
  const stakeAmount = Number(stake);
  const stakeBox = page.getByText("Additional Multiples").locator('xpath=preceding::input[@aria-label="Stake"][1]');
  await stakeBox.fill(String(stakeAmount));
  // Verified, not trusted -- confirmed live that a successful fill flips
  // the Place Bet button's own label to include the amount ("Please Enter
  // Stake" -> "Place £X.XX Bet"), a real signal the fill actually
  // registered, not just that .fill() didn't throw.
  const placeButton = page.getByRole("button", { name: `Place £${stakeAmount.toFixed(2)} Bet` });
  if ((await placeButton.count()) === 0) {
    throw new Error(`Stake fill for £${stakeAmount.toFixed(2)} didn't produce the matching "Place Bet" button -- may not have registered`);
  }
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Saves a screenshot of the built slip and logs its path with a distinct,
// greppable prefix -- driver.js has no Telegram integration of its own (no
// messaging capability exists in this file at all), so this is the hand-off
// contract: whatever wraps this script (OpenClaw, per the pending
// integration decision) is responsible for finding this path and actually
// sending it to Winston. Winston's own explicit requirement after tonight's
// test runs: a screenshot + notification per bet, not a silent relay POST.
async function takeScreenshot(page, player, label) {
  const dir = "./screenshots";
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  const path = `${dir}/${player}-${label}-${Date.now()}.png`;
  await page.screenshot({ path, fullPage: true });
  console.log(`[betfair-driver] SCREENSHOT_READY: ${path}`);
  return path;
}

// Claims the next pending job from the relay's queue -- the same
// /betfair-place-request/next endpoint Anne's own cron poll uses, with the
// same one-at-a-time serialization (getNext() returns null if anything's
// already claimed, not just when the queue is empty). Confirmed live
// (2026-09-22): driver.js originally skipped this and went straight to the
// read-only /betfair-export instead, so /awaiting-confirmation correctly
// 404'd later -- there was never a claimed entry for it to attach to.
// Whoever the queue hands back is who gets processed; there's no way to
// request a specific player, same as Anne never could either.
// Confirmed live (2026-09-22): /next already server-side filters bets to
// just this player -- data.bets normally holds BOTH of their bet columns
// (Bet 1, Bet 2, the product's actual two-bet-per-player structure), not
// one. An earlier version used .find() here and silently discarded the
// second one, with no mechanism at all to build/report it afterward. Kept
// sorted by sheetColIdx so Bet 1 always processes before Bet 2, matching
// how the columns are laid out in the Sheet.
async function claimNextJob() {
  const res = await fetch(`${RELAY_URL}/betfair-place-request/next`);
  if (!res.ok) throw new Error(`betfair-place-request/next ${res.status}`);
  const data = await res.json();
  if (!data.job) return null;
  const bets = (data.bets || []).filter((b) => b.player === data.job.player).sort((a, b) => a.sheetColIdx - b.sheetColIdx);
  if (!bets.length) throw new Error(`Claimed a job for "${data.job.player}" but /next returned no matching bets for them`);
  return { player: data.job.player, test: data.job.test, bets };
}

async function postAwaitingConfirmation(player, pendingBet) {
  const res = await fetch(`${RELAY_URL}/betfair-place-request/awaiting-confirmation`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player, bet: pendingBet }),
  });
  if (!res.ok) throw new Error(`awaiting-confirmation ${res.status}`);
}

// Atomically reads (and clears) Winston's decision, same as Anne's own poll
// always used -- see betfairQueue.js's takeDecision(). Polls rather than a
// single check, since a real confirmation can reasonably take minutes or
// hours (awaiting_confirmation deliberately has no expiry of its own, see
// markAwaitingConfirmation()'s own comment) -- this loop is the actual
// decision-consumer that was entirely missing before tonight (confirmed
// live: no cron/launchd/agent process existed anywhere to do this).
async function pollForDecision(player, { intervalMs = 20000, logEveryMs = 300000 } = {}) {
  let lastLog = Date.now();
  console.log(`[betfair-driver] SCREENSHOT_READY handoff above -- now waiting for ${player}'s approval in the app. Whatever wraps this script should send that screenshot + a notification now.`);
  for (;;) {
    const res = await fetch(`${RELAY_URL}/betfair-place-request/decision?player=${encodeURIComponent(player)}`);
    if (!res.ok) throw new Error(`betfair-place-request/decision ${res.status}`);
    const data = await res.json();
    if (data.decision) return data.decision;
    if (Date.now() - lastLog > logEveryMs) { console.log(`[betfair-driver] Still waiting on ${player}'s decision...`); lastLog = Date.now(); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Best-effort, idempotent -- safe to call even if the slip's already empty
// (real placement clears it automatically; test mode never does, so this is
// what stops Bet 1's legs bleeding into Bet 2's build and merging into one
// wrong combined slip instead of two separate accumulators).
// Verified, not swallowed -- this is the actual root cause of the empty-slip
// bug, confirmed live (2026-09-22): the old version's .catch(() => {})
// silently ate any failure to actually clear the slip. If a prior run left
// legs selected and this call silently didn't remove them, every leg-click
// afterward would land on an already-selected (toggle) button and turn it
// back OFF instead of adding it -- zero errors thrown anywhere, final
// betslip empty. "Remove all" only shows up when the slip is non-empty, so
// skip clicking it if the slip already reads empty (avoids a pointless
// timeout on a genuinely-fresh slip), but always verify the end state
// either way.
async function clearBetslip(page) {
  const before = await betslipSnapshot(page);
  if (before.toLowerCase().includes("betslip is empty")) return;
  await page.getByRole("button", { name: "Remove all" }).click({ timeout: 5000 }).catch(() => {});
  const after = await betslipSnapshot(page);
  if (!after.toLowerCase().includes("betslip is empty")) {
    throw new Error(`clearBetslip failed -- betslip not empty after Remove all: "${after}"`);
  }
}

async function reportPlaced(player, test) {
  // test:true skips every real Sheet write (see server.js's own comment on
  // this endpoint) -- no real win amounts exist for a job that was only
  // ever simulated, and sending fake ones would corrupt real Sheet data.
  // Still clears the queue claim exactly like a real result would.
  const res = await fetch(`${RELAY_URL}/betfair-place-result`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player, test, results: [] }),
  });
  if (!res.ok) throw new Error(`betfair-place-result ${res.status}`);
}

// A reject means nothing was (or, in test mode, would have been) placed --
// there's no result to report, just an unstick. /betfair-place-result
// assumes something WAS placed (or is a test run standing in for one); it
// isn't the right shape for "never placed, stop here."
async function clearJob(player) {
  const res = await fetch(`${RELAY_URL}/betfair-place-request/clear`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player }),
  });
  if (!res.ok) throw new Error(`betfair-place-request/clear ${res.status}`);
}

// Builds the bet on Betfair up to (never including) the actual Place Bet
// click -- that stays gated behind the app's existing approve/reject flow
// (admin.html's queue panel), same as every other placement path in this
// project. This function's job ends at "slip built, verified, reported."
// withAiFallback is passed in (not created here) so its entries array --
// and every real metrics delta recorded in it -- stays reachable from
// main()'s catch block even if this function throws partway through, not
// just on a clean return.
async function buildBetOnBetfair(page, stagehand, plan, withAiFallback) {
  if (plan.conflicts.length) throw new SameMatchConflictError(plan.conflicts);

  const fixtureIndex = await buildFixtureIndex(page, plan.matchesNeeded);

  for (const step of plan.steps) {
    const fixtureEntry = fixtureIndex[step.match];
    // Self-contained on purpose -- fixtureEntry may be null (buildFixtureIndex
    // couldn't resolve this match deterministically), so the fallback can't
    // assume it's already on the right page or even knows the match's URL.
    // Telling it to navigate from the fixtures list itself if needed means it
    // can still recover a match buildFixtureIndex missed entirely, not just
    // one where the index resolved but a click/type target didn't.
    const description = step.type === "list-pick"
      ? `On the EPL fixtures list (${EPL_FIXTURES_URL}), find the ${step.match} fixture and click its ${step.position} price button`
      : `Navigate to the ${step.match} match page (search the EPL fixtures list at ${EPL_FIXTURES_URL} first if you're not already there), then back "${step.selection}" in the ${step.market} market`;
    await withAiFallback(page, stagehand, description, step.match, step.selection, () =>
      step.type === "list-pick" ? executeListPick(page, step, fixtureEntry) : executeMatchPagePick(page, step, fixtureEntry)
    );
  }

  await verifyMultiples(page);
  await fillStake(page, plan.stake);
}

// Raised deliberately, not silently skipped -- real placement (clicking
// Place Bet with real money) is NOT implemented in this file. Given this
// project's own history (a real accidental live placement earlier from a
// missed env var), guessing at that click without careful, explicit review
// is exactly the kind of shortcut this whole rewrite exists to avoid. Test
// mode's approve path is fully implemented (simulate, don't click,
// continue); real mode's approve path hard-stops here on purpose until
// someone deliberately builds and reviews it.
class RealPlacementNotImplementedError extends Error {
  constructor(player) { super(`${player}'s bet was approved for REAL placement, but driver.js doesn't implement clicking Place Bet yet -- refusing to proceed automatically. Needs deliberate review before this path exists.`); this.name = "RealPlacementNotImplementedError"; }
}

async function main() {
  // No player CLI arg anymore -- claimNextJob() (like Anne's own poll)
  // takes whichever job the queue hands back, it can't be requested by
  // name. Run `POST /betfair-place-request` (the app's "place bet" button,
  // or manually) first to actually have something pending to claim.
  const claimed = await claimNextJob();
  if (!claimed) { console.log("[betfair-driver] No pending job in the queue -- nothing to do."); process.exit(0); }
  const { player, test, bets } = claimed;
  console.log(`[betfair-driver] Claimed job for ${player}${test ? " (test mode)" : ""} -- ${bets.length} bet(s) to build.`);

  // Connect to Anne/OpenClaw's already-running browser rather than
  // launching anything -- confirmed live (2026-09-22) via a standalone
  // connectOverCDP test that this works and inherits its already-working
  // GB routing + login. Caller must have already run `openclaw browser
  // start` (or equivalent) so this port is actually open; driver.js doesn't
  // start it, only connects to it.
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`No browser context found at ${CDP_URL} -- is Anne's browser actually running and logged in?`);
  // A NEW page, deliberately -- never touch whatever tab Anne might already
  // have open, per this file's own concurrency note above.
  const page = await context.newPage();
  // One shared log across BOTH bets -- real cost data should reflect the
  // whole job, not reset per bet.
  const { withAiFallback, entries: fallbackLog } = makeFallbackLog();

  // Navigate once, up front -- confirmed live (2026-09-22): a brand-new
  // page.newPage() tab starts on about:blank, and clearBetslip() (called at
  // the top of the loop below, for every bet including Bet 1) needs a real
  // Betfair page loaded to find the "Betslip" panel at all. Calling it
  // before any navigation threw immediately (getByText('Betslip') timing
  // out on a blank page), a real bug from Bet 1 never even reaching the
  // build step. This isn't just a Bet-1-specific skip, though -- account-
  // level betslip state (confirmed live) persists and gets restored on ANY
  // fresh navigation, so Bet 1 needs the same clear-and-verify protection
  // Bet 2 does, not an exemption. Navigating once here, before the loop,
  // gives clearBetslip() a real page to check on every iteration.
  await page.goto(EPL_FIXTURES_URL, { waitUntil: "networkidle" });
  assertNotChallenged(page);

  try {
    for (const [i, exportedBet] of bets.entries()) {
      const label = `bet${i + 1}`;
      const plan = buildBetPlan(exportedBet);
      if (plan.skipped.length) {
        console.log(`[betfair-driver] ${label}: ${plan.skipped.length} leg(s) skipped (needs manual check):`, plan.skipped);
      }

      // Idempotent, always run -- Bet 1's legs are still sitting in the
      // slip going into Bet 2's build (test mode never places for real, so
      // nothing clears it automatically), which would otherwise merge into
      // one wrong combined slip instead of two separate accumulators.
      await clearBetslip(page);

      // Constructed fresh per bet, not once for the whole job -- confirmed
      // live (2026-09-22): a StagehandTargetClosedError ("Target closed
      // before CDP session could attach") hit exactly at the Bet 1 -> Bet 2
      // handoff, right after a real multi-minute idle wait in
      // pollForDecision for Winston's approval. Leading hypothesis: the CDP
      // session Stagehand attaches during init() isn't resilient to sitting
      // idle that long -- rebuilding it right before each bet needs it,
      // rather than once up front, means it's never asked to survive an
      // idle gap. Untested live as of this fix; watch whether this recurs
      // on the next Bet 1 -> Bet 2 transition.
      //
      // modelName pinned explicitly to gpt-5-mini -- same model tested and
      // approved for this project already (zero Sonnet anywhere in the
      // chain). Provider prefix ("openai/") is required, not optional --
      // confirmed live (2026-09-22) by reading the installed
      // @browserbasehq/stagehand source directly: a bare "gpt-5-mini" isn't
      // in this version's native modelToProviderMap, so it silently
      // resolves to no LLM client at all rather than erroring clearly.
      //
      // cdpUrl set explicitly, `page` option dropped -- confirmed live
      // (2026-09-22), read directly from the installed
      // @browserbasehq/stagehand@2.5.9 source: `page` was NEVER a
      // recognized constructor parameter in this version at all (the full
      // constructor param list has no `page` anywhere in it -- JS
      // destructuring just silently ignores it). With cdpUrl left
      // undefined, init() unconditionally fell through to launching its OWN
      // separate, unauthenticated throwaway browser via
      // launchPersistentContext -- confirmed as the exact source of a
      // blank Chrome window opening on every bet build. Passing the same
      // CDP_URL driver.js itself connects with makes Stagehand attach to
      // Anne's real browser instead of launching a new one.
      const stagehand = new Stagehand({ env: "LOCAL", modelName: "openai/gpt-5-mini", localBrowserLaunchOptions: { cdpUrl: CDP_URL } });
      // Confirmed live (2026-09-22), Stagehand's own error was explicit:
      // init() is required before .page/.act() are usable, the constructor
      // alone doesn't set it up.
      await stagehand.init();
      // Confirmed live (2026-09-22) with a screenshot: without this,
      // Stagehand's fallback acted on a completely different, leftover tab
      // than driver.js's own real one -- a lost leg, not a lost error.
      // Traced directly in source: StagehandContext.init() walks
      // context.pages() and activates whichever page it finds first, with
      // no way to specify one via the constructor. getStagehandPage() is
      // the real, public (not underscore-prefixed) override -- wraps the
      // given page and sets it as the active one, which stagehand.page's
      // proxy reads from. This is the confirmed, intended mechanism, not a
      // workaround (e.g. closing other tabs first, which risked closing
      // something Anne was actually using).
      await stagehand.stagehandContext.getStagehandPage(page);

      await buildBetOnBetfair(page, stagehand, plan, withAiFallback);
      const screenshotPath = await takeScreenshot(page, player, label);
      await postAwaitingConfirmation(player, { stake: plan.stake, legs: plan.steps, skipped: plan.skipped, screenshotPath, betNumber: i + 1 });
      console.log(`[betfair-driver] ${label} built and reported for ${player}.`);

      const decision = await pollForDecision(player);
      console.log(`[betfair-driver] ${label} decision: ${decision}`);

      if (decision === "reject") {
        await clearJob(player);
        console.log(`[betfair-driver] ${player} rejected ${label} -- stopping here, not building any further bets for this job.`);
        break;
      }

      // decision === "approve" from here on.
      if (!test) throw new RealPlacementNotImplementedError(player);
      console.log(`[betfair-driver] ${label} approved (test mode) -- simulating placement, not clicking Place Bet.`);

      // Only report as fully placed once every bet in this job has been
      // approved -- reportPlaced() clears the queue claim, which should
      // only happen after the LAST bet, not after Bet 1 while Bet 2 is
      // still pending.
      if (i === bets.length - 1) await reportPlaced(player, test);
    }
  } catch (err) {
    console.error(`[betfair-driver] Hard stop for ${player}:`, err.message);
    process.exitCode = 1;
    // Deliberately no Telegram/notify call here -- this script reports via
    // stdout/exit code only. Whatever wraps it (OpenClaw, per the pending
    // integration decision) owns telling Winston, same as it does today.
  } finally {
    // Summed from each call's own before/after delta, not the raw
    // stagehand.metrics aggregate -- see makeFallbackLog()'s comment for why
    // that aggregate was confirmed unreliable (identical counts across
    // different calls). Real, per-call measured cost data, logged
    // regardless of success or hard stop -- a fallback may have already run
    // and cost something before a later step failed.
    console.log(`[betfair-driver] AI fallback used ${fallbackLog.length} time(s) across this job:`, fallbackLog);
    console.log(`[betfair-driver] Real summed usage/cost this run:`, sumMetrics(fallbackLog.map((e) => e.metrics)));
    // Close only the tab this script opened -- never context.close() or
    // browser.close() here, either of those would tear down Anne's actual
    // running browser out from under her.
    await page.close().catch(() => {});
  }

  // The CDP WebSocket connection keeps a live handle open even after the
  // page is closed, which stops the process from exiting naturally --
  // confirmed live (2026-09-22): the first real test run hung indefinitely
  // and had to be killed by signal (exit code 143) despite finishing its
  // work. Doesn't touch the remote browser at all, just this process.
  process.exit(process.exitCode || 0);
}

main();
