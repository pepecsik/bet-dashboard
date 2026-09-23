// Drives a real Betano bet build for whichever player is next in the
// relay's placement queue -- BOTH of their bets (Bet 1 then Bet 2, this
// product's actual two-bet-per-player structure), waiting for Winston's
// approval in the app between each one. Uses the ordered plan from
// ../betanoPlan.js and the page structure documented in
// ../BETANO_RECON.md. Runs on the Mac, invoked as `node driver.js` -- no
// player arg, it claims /betfair-place-request/next the same way the
// retired Betfair driver did, so there needs to be an actual pending
// request first (the app's "place bet" button, or POST
// /betfair-place-request manually).
//
// This is Winston's OWN, ID-verified Betano account -- no VPN, no
// third-party account access question, unlike the retired Betfair attempt.
// Connects to an already-running "betano" browser profile via CDP
// (chromium.connectOverCDP), the same architecture that ended up working
// for Betfair after a lot of real live debugging -- applying everything
// learned there as a starting point this time, rather than rediscovering
// each bug again:
// - Deterministic Playwright locators do essentially everything; Stagehand
//   is wired in ONLY as a narrow, logged, VERIFIED fallback for the exact
//   step that fails, never for open-ended planning or for reproducing a
//   literal URL (confirmed live, twice, on Betfair: LLMs are not reliable
//   for verbatim string reproduction no matter how explicit the
//   instruction -- known URLs are always navigated to deterministically).
// - Stagehand is bound to driver.js's own real page explicitly via
//   getStagehandPage(), not left to whichever tab context.pages() returns
//   first -- confirmed live on Betfair that leaving this implicit silently
//   acted on a leftover tab instead.
// - Every claimed-successful action (a click, a clear) is verified against
//   the real page state afterward, never trusted just because it didn't
//   throw -- confirmed live on Betfair that a "successful" click can
//   silently do nothing (a toggle-off from stale state) or a "successful"
//   AI fallback call can silently not add anything.
// - Never resize this profile's viewport once loaded, per BETANO_RECON.md's
//   own gotcha (breaks the floating betslip's positioning and isn't fixed
//   by anything short of a reload).
//
// IMPORTANT -- selector accuracy: most locators below come directly from a
// real, careful recon pass (BETANO_RECON.md), but a few specific ones
// (marked UNVERIFIED below) couldn't be pinned down from that recon alone
// and need live confirmation on the first real run -- flagged explicitly
// rather than presented as certain.

import { chromium } from "playwright";
import { Stagehand } from "@browserbasehq/stagehand";
import { buildBetPlan } from "../betanoPlan.js";

const RELAY_URL = process.env.RELAY_URL || "https://bet-dashboard-relay.onrender.com";
// The "betano" browser profile must already be running with this CDP port
// open before driver.js runs -- this script connects to it, it doesn't
// start it. Port UNVERIFIED against whatever OpenClaw actually assigns the
// betano profile -- confirm and override via env var if different.
const CDP_URL = process.env.BETANO_CDP_URL || "http://127.0.0.1:8093";
const EPL_FIXTURES_URL = "https://www.betano.pt/en/sport/soccer/england/premier-league/1/";
const POSITION_LABEL = { home: "1", draw: "X", away: "2" };

class CloudflareChallengeError extends Error {
  constructor(url) { super(`Cloudflare/CAPTCHA challenge at ${url} -- hard stop, needs manual clearing`); this.name = "CloudflareChallengeError"; }
}
class SameMatchConflictError extends Error {
  constructor(matches) { super(`Same match appears in multiple legs: ${matches.join(", ")} -- refusing to build a same-match combo`); this.name = "SameMatchConflictError"; }
}
class RealPlacementNotImplementedError extends Error {
  constructor(player) { super(`${player}'s bet was approved for REAL placement, but driver.js doesn't implement clicking BET NOW yet -- refusing to proceed automatically. Needs deliberate review before this path exists.`); this.name = "RealPlacementNotImplementedError"; }
}

function assertNotChallenged(page) {
  const url = page.url();
  // No Cloudflare was ever seen against Betano during recon -- this stays a
  // hard stop on general principle (never attempt to click through any
  // anti-bot challenge, on any site), not because one's expected here.
  if (/captcha|challenge|cf-|turnstile/i.test(url)) throw new CloudflareChallengeError(url);
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Ground truth for "what does Betano itself think is selected right now" --
// never trust a click's own success/no-error as proof it worked. Scoped to
// the floating betslip widget specifically (`.bet-slip-container`), per
// BETANO_RECON.md section 3 -- it's position:fixed and won't composite into
// an ordinary page screenshot correctly, and isn't part of normal page
// flow, so reading its actual text content directly is the reliable way to
// check it, same idea as Betfair's betslipSnapshot() but scoped by
// selector instead of walking up from a text match (Betano's own DOM
// structure for this wasn't fully mapped in recon).
async function betslipSnapshot(page) {
  return await page.locator(".bet-slip-container").innerText({ timeout: 5000 }).catch((e) => `<error: ${e.message}>`);
}

function selectionAppearsIn(snapshot, selection) {
  if (selection === "The Draw") return snapshot.includes("Draw") || / X /.test(snapshot);
  return snapshot.includes(selection);
}

// UNVERIFIED -- confirm live. Per BETANO_RECON.md, "Remove selections"
// appears both as the top-level clear-all button (right after the
// "Betslip" heading) AND once per leg (removes just that leg) -- same
// accessible name for both, no distinguishing detail captured during
// recon. Using .first() as a best guess (the top-level one is documented
// as appearing first, before any per-leg content), not a confirmed fact.
async function clearBetslip(page) {
  const snapshot = await betslipSnapshot(page);
  if (!snapshot || /^<error/.test(snapshot)) return; // no betslip container at all yet -- nothing to clear
  await page.locator(".bet-slip-container").getByRole("button", { name: "Remove selections" }).first().click({ timeout: 5000 }).catch(() => {});
  const after = await betslipSnapshot(page);
  if (after && !/^<error/.test(after) && after.trim().length > 0 && !/betslip/i.test(after.split("\n")[0] || "")) {
    // Best-effort check only -- there's no single confirmed "empty" string
    // to match against (unlike Betfair's literal "betslip is empty" text),
    // so this can't throw confidently on failure the way Betfair's version
    // could. Logged, not hard-failed, pending a real confirmed empty-state
    // string from a live run.
    console.warn(`[betano-driver] clearBetslip: betslip may not be empty after clearing -- "${after}"`);
  }
}

// Scans the EPL fixtures list once and returns a map keyed by "Home vs Away"
// -> { href, link, positionButtons } for every match this player's plan
// needs, built once per bet and reused for every list-pick AND to get each
// match-page href (never guessed/reconstructed from team names -- per
// BETANO_RECON.md, Betano silently 302-redirects some slugs).
//
// UNVERIFIED row-scoping -- confirm live. BETANO_RECON.md documents the
// fixture row's accessibility-tree shape (link, then 3 named price
// buttons) but not the exact DOM wrapper tag/class the way it did for
// Betfair's `couponEventScoreContainer`. Using the same
// nearest-tr/li/div-ancestor heuristic that worked for Betfair as a
// starting hypothesis, not a confirmed fact for this site.
async function buildFixtureIndex(page, matchesNeeded) {
  await page.goto(EPL_FIXTURES_URL, { waitUntil: "networkidle" });
  assertNotChallenged(page);

  const index = {};
  for (const { match, homeTeam, awayTeam } of matchesNeeded) {
    try {
      const link = page.getByRole("link", { name: new RegExp(`${escapeRegex(homeTeam)}.*${escapeRegex(awayTeam)}`, "i") }).first();
      const href = await link.getAttribute("href");
      const row = link.locator("xpath=ancestor::*[self::tr or self::li or self::div][1]");
      index[match] = { href, row };
    } catch (err) {
      if (err instanceof CloudflareChallengeError) throw err;
      // Isolated per match, on purpose -- same lesson as Betfair's build:
      // one match's lookup failure must not abort every other match's
      // already-working lookup too.
      index[match] = null;
    }
  }
  return index;
}

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
  const label = POSITION_LABEL[step.position];
  // Full-sentence accessible names on Betano ("Bet on 1 with odds 1.39."),
  // unlike Betfair's price-only buttons -- matched by prefix within the
  // row, not by position index.
  const button = fixtureEntry.row.getByRole("button", { name: new RegExp(`^Bet on ${escapeRegex(label)} with odds`, "i") });
  await clickAndVerifyLeg(page, button, step.match, step.selection);
}

async function executeMatchPagePick(page, step, fixtureEntry) {
  if (!fixtureEntry || !fixtureEntry.href) throw new Error(`No captured href for "${step.match}" -- can't navigate without guessing the URL`);
  const url = new URL(fixtureEntry.href, "https://www.betano.pt").toString();
  await page.goto(url, { waitUntil: "networkidle" });
  assertNotChallenged(page);

  if (step.needsExpand) {
    // Correct Score is a collapsed accordion by default -- expand it first.
    await page.getByText("Correct Score", { exact: true }).click();
  }

  if (step.market === "Correct Score") {
    const scoreline = step.selection.replace("-", " - "); // "2-1" -> "2 - 1", matching the recon file's documented label format
    const button = page.getByRole("button", { name: new RegExp(`^Bet on ${escapeRegex(scoreline)} with odds`, "i") });
    await clickAndVerifyLeg(page, button, step.match, step.selection);
    return;
  }

  if (step.market.startsWith("Over/Under")) {
    const m = step.selection.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`Unrecognized Over/Under selection format: "${step.selection}"`);
    const [, direction, line] = m;
    const button = page.getByRole("button", { name: new RegExp(`^Bet on ${direction} ${escapeRegex(line)} with odds`, "i") });
    if ((await button.count()) === 0) {
      // Higher goal lines are hidden behind "SHOW ALL" by default, per
      // BETANO_RECON.md (same pattern as Betfair's "Show More").
      await page.getByRole("button", { name: "SHOW ALL" }).first().click();
    }
    await clickAndVerifyLeg(page, button, step.match, step.selection);
    return;
  }

  throw new Error(`Unhandled market "${step.market}" in executeMatchPagePick`);
}

// Confirms the betslip actually combined into "Multiple" mode -- per
// BETANO_RECON.md section 4, a same-match conflict doesn't error, it just
// silently forces "Single" (2 legs) or "System" (3+) instead, with no
// combined odds. betanoPlan.js's own conflict check should make this
// unreachable in practice (see its file-level comment), but verifying the
// real on-page state is the only way to be sure Betano agrees.
async function verifyMultiple(page) {
  const multipleRadio = page.getByRole("radio", { name: "Multiple" });
  const checked = await multipleRadio.isChecked().catch(() => false);
  if (!checked) {
    const snapshot = await betslipSnapshot(page);
    throw new SameMatchConflictError([`betslip not in Multiple mode -- current state: "${snapshot}"`]);
  }
}

// UNVERIFIED exact selector -- confirm live. BETANO_RECON.md documents
// that Multiple mode has ONE shared stake textbox but doesn't give it a
// specific aria-label the way Betfair's was confirmed (aria-label="Stake").
// Scoped to the betslip container and taking the only textbox in it, which
// should be correct once verifyMultiple() has already confirmed single
// shared-stake mode.
async function fillStake(page, stake) {
  const stakeAmount = Number(stake);
  const stakeBox = page.locator(".bet-slip-container").getByRole("textbox").first();
  await stakeBox.fill(String(stakeAmount));
  // Verified via the BET NOW button's own label, which embeds the live
  // potential-winnings figure once a stake is entered (see
  // BETANO_RECON.md section 5) -- if it still reads as disabled/no amount,
  // the fill didn't register.
  const betNow = page.getByRole("button", { name: /BET NOW/i });
  const label = await betNow.innerText().catch(() => "");
  if (!new RegExp(String(stakeAmount).replace(".", "[.,]")).test(label)) {
    throw new Error(`Stake fill for ${stakeAmount} didn't appear to register on BET NOW's label: "${label}"`);
  }
}

async function takeScreenshot(page, player, label) {
  const dir = "./screenshots";
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  const path = `${dir}/${player}-${label}-${Date.now()}.png`;
  // Element-scoped, not a full-page screenshot -- per BETANO_RECON.md, the
  // betslip is position:fixed and doesn't composite into an ordinary
  // full-page screenshot correctly.
  await page.locator(".bet-slip-container").screenshot({ path });
  console.log(`[betano-driver] SCREENSHOT_READY: ${path}`);
  return path;
}

function metricsDelta(before, after) {
  const delta = {};
  Object.keys(after || {}).forEach((k) => { if (typeof after[k] === "number") delta[k] = after[k] - ((before && before[k]) || 0); });
  return delta;
}
function sumMetrics(deltas) {
  const total = {};
  deltas.forEach((d) => Object.keys(d).forEach((k) => { total[k] = (total[k] || 0) + d[k]; }));
  return total;
}

function makeFallbackLog() {
  const entries = [];
  return {
    entries,
    async withAiFallback(page, stagehand, description, matchLabel, selection, knownUrl, deterministicFn) {
      try {
        return await deterministicFn();
      } catch (err) {
        if (err instanceof CloudflareChallengeError) throw err;
        if (knownUrl) {
          await page.goto(knownUrl, { waitUntil: "networkidle" });
          assertNotChallenged(page);
        }
        const before = { ...stagehand.metrics };
        const result = await stagehand.page.act(description);
        const after = { ...stagehand.metrics };
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

async function buildBetOnBetano(page, stagehand, plan, withAiFallback) {
  if (plan.conflicts.length) throw new SameMatchConflictError(plan.conflicts);

  const fixtureIndex = await buildFixtureIndex(page, plan.matchesNeeded);

  for (const step of plan.steps) {
    const fixtureEntry = fixtureIndex[step.match];
    const knownUrl = fixtureEntry && fixtureEntry.href ? new URL(fixtureEntry.href, "https://www.betano.pt").toString() : null;
    const description = step.type === "list-pick"
      ? `On the EPL fixtures list (${EPL_FIXTURES_URL}), find the ${step.match} fixture and click its "${POSITION_LABEL[step.position]}" price button`
      : knownUrl
        ? `Back "${step.selection}" in the ${step.market} market on this page.`
        : `Navigate to the ${step.match} match page (search the EPL fixtures list at ${EPL_FIXTURES_URL} first if you're not already there), then back "${step.selection}" in the ${step.market} market`;
    await withAiFallback(page, stagehand, description, step.match, step.selection, step.type === "match-page-pick" ? knownUrl : null, () =>
      step.type === "list-pick" ? executeListPick(page, step, fixtureEntry) : executeMatchPagePick(page, step, fixtureEntry)
    );
  }

  await verifyMultiple(page);
  await fillStake(page, plan.stake);
}

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

async function pollForDecision(player, { intervalMs = 20000, logEveryMs = 300000 } = {}) {
  let lastLog = Date.now();
  console.log(`[betano-driver] SCREENSHOT_READY handoff above -- now waiting for ${player}'s approval in the app.`);
  for (;;) {
    const res = await fetch(`${RELAY_URL}/betfair-place-request/decision?player=${encodeURIComponent(player)}`);
    if (!res.ok) throw new Error(`betfair-place-request/decision ${res.status}`);
    const data = await res.json();
    if (data.decision) return data.decision;
    if (Date.now() - lastLog > logEveryMs) { console.log(`[betano-driver] Still waiting on ${player}'s decision...`); lastLog = Date.now(); }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function reportPlaced(player, test) {
  const res = await fetch(`${RELAY_URL}/betfair-place-result`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player, test, results: [] }),
  });
  if (!res.ok) throw new Error(`betfair-place-result ${res.status}`);
}

async function clearJob(player) {
  const res = await fetch(`${RELAY_URL}/betfair-place-request/clear`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player }),
  });
  if (!res.ok) throw new Error(`betfair-place-request/clear ${res.status}`);
}

async function main() {
  const claimed = await claimNextJob();
  if (!claimed) { console.log("[betano-driver] No pending job in the queue -- nothing to do."); process.exit(0); }
  const { player, test, bets } = claimed;
  console.log(`[betano-driver] Claimed job for ${player}${test ? " (test mode)" : ""} -- ${bets.length} bet(s) to build.`);

  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`No browser context found at ${CDP_URL} -- is the betano profile actually running and logged in?`);
  const page = await context.newPage();

  const { withAiFallback, entries: fallbackLog } = makeFallbackLog();

  // Navigate once, up front -- same lesson as Betfair's build: a brand-new
  // page.newPage() tab starts on about:blank, and clearBetslip() (called
  // at the top of the loop below, for every bet including Bet 1) needs a
  // real page loaded to check at all.
  await page.goto(EPL_FIXTURES_URL, { waitUntil: "networkidle" });
  assertNotChallenged(page);

  try {
    for (const [i, exportedBet] of bets.entries()) {
      const label = `bet${i + 1}`;
      const plan = buildBetPlan(exportedBet);
      if (plan.skipped.length) {
        console.log(`[betano-driver] ${label}: ${plan.skipped.length} leg(s) skipped (needs manual check):`, plan.skipped);
      }

      await clearBetslip(page);

      // Stagehand rebuilt fresh per bet, not once for the whole job --
      // confirmed live on Betfair's build: its CDP session didn't survive
      // sitting idle through pollForDecision's real multi-minute wait.
      const stagehand = new Stagehand({ env: "LOCAL", modelName: "openai/gpt-5-mini", localBrowserLaunchOptions: { cdpUrl: CDP_URL } });
      await stagehand.init();
      await stagehand.stagehandContext.getStagehandPage(page);

      await buildBetOnBetano(page, stagehand, plan, withAiFallback);
      const screenshotPath = await takeScreenshot(page, player, label);
      await postAwaitingConfirmation(player, { stake: plan.stake, legs: plan.steps, skipped: plan.skipped, screenshotPath, betNumber: i + 1 });
      console.log(`[betano-driver] ${label} built and reported for ${player}.`);

      const decision = await pollForDecision(player);
      console.log(`[betano-driver] ${label} decision: ${decision}`);

      if (decision === "reject") {
        await clearJob(player);
        console.log(`[betano-driver] ${player} rejected ${label} -- stopping here, not building any further bets for this job.`);
        break;
      }

      if (!test) throw new RealPlacementNotImplementedError(player);
      console.log(`[betano-driver] ${label} approved (test mode) -- simulating placement, not clicking BET NOW.`);

      if (i === bets.length - 1) await reportPlaced(player, test);
    }
  } catch (err) {
    console.error(`[betano-driver] Hard stop for ${player}:`, err.message);
    console.error(`[betano-driver] Page URL at hard stop: ${page.url()}`);
    try {
      const dir = "./screenshots";
      await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
      const failurePath = `${dir}/HARDSTOP-${player}-${Date.now()}.png`;
      await page.screenshot({ path: failurePath, fullPage: true });
      console.error(`[betano-driver] HARDSTOP_SCREENSHOT_READY: ${failurePath}`);
    } catch (screenshotErr) {
      console.error(`[betano-driver] Could not capture hard-stop screenshot:`, screenshotErr.message);
    }
    process.exitCode = 1;
  } finally {
    console.log(`[betano-driver] AI fallback used ${fallbackLog.length} time(s) across this job:`, fallbackLog);
    console.log(`[betano-driver] Real summed usage/cost this run:`, sumMetrics(fallbackLog.map((e) => e.metrics)));
    await page.close().catch(() => {});
  }

  process.exit(process.exitCode || 0);
}

main();
