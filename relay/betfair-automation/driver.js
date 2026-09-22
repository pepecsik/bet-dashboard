// Drives a real Betfair Sportsbook bet build for whichever player is next
// in the relay's placement queue, using the ordered plan from
// ../betfairPlan.js and the page structure documented in
// ../SPORTSBOOK_RECON.md. Runs on the Mac (needs GB routing + a real
// Betfair login), invoked as `node driver.js` -- no player arg, it claims
// /betfair-place-request/next the same way Anne's own poll does, so there
// needs to be an actual pending request first (the app's "place bet"
// button, or POST /betfair-place-request manually).
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

// Every AI fallback call gets recorded here (step description, timestamp) --
// returned alongside the run's result so the caller can log/report real
// fallback-rate data instead of the plan's original guess.
function makeFallbackLog() {
  const entries = [];
  return {
    entries,
    async withAiFallback(stagehand, description, deterministicFn) {
      try {
        return await deterministicFn();
      } catch (err) {
        if (err instanceof CloudflareChallengeError) throw err; // never paper over a hard stop
        entries.push({ description, deterministicError: err.message, at: new Date().toISOString() });
        return await stagehand.page.act(description);
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

async function executeListPick(page, step, fixtureEntry) {
  if (!fixtureEntry) throw new Error(`No fixture-index entry for "${step.match}" -- link not found on the fixtures list`);
  const positionIdx = { home: 0, draw: 1, away: 2 }[step.position];
  const button = fixtureEntry.priceButtons.nth(positionIdx);
  await button.click();
  assertNotChallenged(page);
}

async function executeMatchPagePick(page, step, fixtureEntry) {
  if (!fixtureEntry || !fixtureEntry.href) throw new Error(`No captured href for "${step.match}" -- can't navigate without guessing the URL`);
  const url = step.tab === "all-markets" ? `https://www.betfair.com${fixtureEntry.href}?tab=all-markets` : `https://www.betfair.com${fixtureEntry.href}`;
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
    await priceButton.click();
    return;
  }

  if (step.market.startsWith("Over/Under")) {
    const m = step.selection.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`Unrecognized Over/Under selection format: "${step.selection}"`);
    const [, direction, line] = m;
    const lineLabel = page.getByText(`${line} Goals`, { exact: true });
    if ((await lineLabel.count()) === 0) {
      // Higher goal lines are hidden behind "Show More" by default.
      await page.getByRole("button", { name: "Show More" }).click();
    }
    const columnIdx = direction === "Over" ? 0 : 1; // Over column, then Under column, per the recon file
    const priceButton = lineLabel.locator("xpath=following::button").nth(columnIdx);
    await priceButton.click();
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

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Claims the next pending job from the relay's queue -- the same
// /betfair-place-request/next endpoint Anne's own cron poll uses, with the
// same one-at-a-time serialization (getNext() returns null if anything's
// already claimed, not just when the queue is empty). Confirmed live
// (2026-09-22): driver.js originally skipped this and went straight to the
// read-only /betfair-export instead, so /awaiting-confirmation correctly
// 404'd later -- there was never a claimed entry for it to attach to.
// Whoever the queue hands back is who gets processed; there's no way to
// request a specific player, same as Anne never could either.
async function claimNextJob() {
  const res = await fetch(`${RELAY_URL}/betfair-place-request/next`);
  if (!res.ok) throw new Error(`betfair-place-request/next ${res.status}`);
  const data = await res.json();
  if (!data.job) return null;
  const bet = (data.bets || []).find((b) => b.player === data.job.player);
  if (!bet) throw new Error(`Claimed a job for "${data.job.player}" but /next returned no matching bet for them`);
  return { player: data.job.player, test: data.job.test, bet };
}

async function postAwaitingConfirmation(player, pendingBet) {
  const res = await fetch(`${RELAY_URL}/betfair-place-request/awaiting-confirmation`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player, bet: pendingBet }),
  });
  if (!res.ok) throw new Error(`awaiting-confirmation ${res.status}`);
}

// Builds the bet on Betfair up to (never including) the actual Place Bet
// click -- that stays gated behind the app's existing approve/reject flow
// (admin.html's queue panel), same as every other placement path in this
// project. This function's job ends at "slip built, verified, reported."
async function buildBetOnBetfair(page, stagehand, plan) {
  const { withAiFallback, entries: fallbackLog } = makeFallbackLog();

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
    await withAiFallback(stagehand, description, () =>
      step.type === "list-pick" ? executeListPick(page, step, fixtureEntry) : executeMatchPagePick(page, step, fixtureEntry)
    );
  }

  await verifyMultiples(page);
  return { fallbackLog };
}

async function main() {
  // No player CLI arg anymore -- claimNextJob() (like Anne's own poll)
  // takes whichever job the queue hands back, it can't be requested by
  // name. Run `POST /betfair-place-request` (the app's "place bet" button,
  // or manually) first to actually have something pending to claim.
  const claimed = await claimNextJob();
  if (!claimed) { console.log("[betfair-driver] No pending job in the queue -- nothing to do."); process.exit(0); }
  const { player, test, bet: exportedBet } = claimed;
  console.log(`[betfair-driver] Claimed job for ${player}${test ? " (test mode)" : ""}.`);

  const plan = buildBetPlan(exportedBet);
  if (plan.skipped.length) {
    console.log(`[betfair-driver] ${plan.skipped.length} leg(s) skipped (needs manual check):`, plan.skipped);
  }

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
  // modelName pinned explicitly to gpt-5-mini -- same model tested and
  // approved for this project already (zero Sonnet anywhere in the chain).
  // Without this, Stagehand falls back to its own default model, which
  // isn't necessarily gpt-5-mini and wasn't the intended test. Provider
  // prefix ("openai/") is required, not optional -- confirmed live
  // (2026-09-22) by reading the installed @browserbasehq/stagehand source
  // directly: a bare "gpt-5-mini" isn't in this version's native
  // modelToProviderMap (predates that model existing), so it silently
  // resolves to no LLM client at all rather than erroring clearly at
  // construction time. A "/"-prefixed name routes through the separate,
  // more general AISDKProviders check instead, which does have "openai".
  const stagehand = new Stagehand({ env: "LOCAL", modelName: "openai/gpt-5-mini", localBrowserLaunchOptions: { cdpUrl: undefined }, page }); // reuses this same page/context
  // Confirmed live (2026-09-22), Stagehand's own error was explicit: init()
  // is required before .page/.act() are usable, the constructor alone
  // doesn't set it up. This resolves the README's flagged open question --
  // wasn't optional for this installed version.
  await stagehand.init();

  try {
    const { fallbackLog } = await buildBetOnBetfair(page, stagehand, plan);
    await postAwaitingConfirmation(player, { stake: plan.stake, legs: plan.steps, skipped: plan.skipped });
    // stagehand.metrics is Stagehand's own built-in usage/cost tracking --
    // logged explicitly here (not just the fallback count) so real per-run
    // cost is visible every time without digging through a separate
    // dashboard, per the project's standing rule of verifying cost claims
    // against real data rather than estimates. Field name/shape unverified
    // against the actual installed version -- check and adjust if this
    // logs undefined.
    console.log(`[betfair-driver] Slip built and reported for ${player}. AI fallback used ${fallbackLog.length} time(s):`, fallbackLog);
    console.log(`[betfair-driver] Stagehand usage/cost this run:`, stagehand.metrics);
  } catch (err) {
    console.error(`[betfair-driver] Hard stop for ${player}:`, err.message);
    console.log(`[betfair-driver] Stagehand usage/cost before the hard stop:`, stagehand.metrics); // a fallback may have already run and cost something before a later step failed
    process.exitCode = 1;
    // Deliberately no Telegram/notify call here -- this script reports via
    // stdout/exit code only. Whatever wraps it (OpenClaw, per the pending
    // integration decision) owns telling Winston, same as it does today.
  } finally {
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
