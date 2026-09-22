// Drives a real Betfair Sportsbook bet build for one player, using the
// ordered plan from ../betfairPlan.js and the page structure documented in
// ../SPORTSBOOK_RECON.md. Runs on the Mac (needs GB routing + a real
// Betfair login), invoked as `node driver.js <player>`.
//
// Deliberately does NOT reuse OpenClaw/Anne's own browser session -- that's
// managed through OpenClaw's gateway, not something a plain script can
// attach to. Instead this launches its own independent, persistent Chrome
// profile via Playwright (chromium.launchPersistentContext), so it never
// depends on OpenClaw's internals to run. See README.md for the one-time
// manual login this profile needs before the first real run.
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
const PROFILE_DIR = process.env.BETFAIR_PROFILE_DIR || "./betfair-chrome-profile";
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
    // The fixture link's accessible name is "<Home> <Away> <date/time>" --
    // matching on both team names anchors it even though the exact date/time
    // text isn't known ahead of time.
    const link = page.getByRole("link", { name: new RegExp(`${escapeRegex(homeTeam)}.*${escapeRegex(awayTeam)}`, "i") }).first();
    const href = await link.getAttribute("href");
    // The three price buttons (home/draw/away) are the row's next three
    // sibling buttons after the link, per the documented row structure.
    const row = link.locator("xpath=ancestor::*[self::tr or self::li or self::div][1]");
    const priceButtons = row.getByRole("button");
    index[match] = { href, priceButtons };
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

async function fetchExportedBet(player) {
  const res = await fetch(`${RELAY_URL}/betfair-export`);
  if (!res.ok) throw new Error(`betfair-export ${res.status}`);
  const data = await res.json();
  const bet = (data.bets || []).find((b) => b.player === player);
  if (!bet) throw new Error(`No exported bet found for player "${player}"`);
  return bet;
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
    const description = step.type === "list-pick"
      ? `Click the ${step.position} price button for the ${step.match} fixture on this list`
      : `On the ${step.match} match page, back "${step.selection}" in the ${step.market} market`;
    await withAiFallback(stagehand, description, () =>
      step.type === "list-pick" ? executeListPick(page, step, fixtureEntry) : executeMatchPagePick(page, step, fixtureEntry)
    );
  }

  await verifyMultiples(page);
  return { fallbackLog };
}

async function main() {
  const player = process.argv[2];
  if (!player) { console.error("Usage: node driver.js <Player>"); process.exit(1); }

  const exportedBet = await fetchExportedBet(player);
  const plan = buildBetPlan(exportedBet);
  if (plan.skipped.length) {
    console.log(`[betfair-driver] ${plan.skipped.length} leg(s) skipped (needs manual check):`, plan.skipped);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  const page = context.pages()[0] || (await context.newPage());
  const stagehand = new Stagehand({ env: "LOCAL", localBrowserLaunchOptions: { cdpUrl: undefined }, page }); // reuses this same page/context -- see README's open question on exact wiring for this Stagehand version

  try {
    const { fallbackLog } = await buildBetOnBetfair(page, stagehand, plan);
    await postAwaitingConfirmation(player, { stake: plan.stake, legs: plan.steps, skipped: plan.skipped });
    console.log(`[betfair-driver] Slip built and reported for ${player}. AI fallback used ${fallbackLog.length} time(s):`, fallbackLog);
  } catch (err) {
    console.error(`[betfair-driver] Hard stop for ${player}:`, err.message);
    process.exitCode = 1;
    // Deliberately no Telegram/notify call here -- this script reports via
    // stdout/exit code only. Whatever wraps it (OpenClaw, per the pending
    // integration decision) owns telling Winston, same as it does today.
  } finally {
    await context.close();
  }
}

main();
