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
// Testing lever, opt-in, test-mode only: lets bet 1's full
// build -> screenshot -> approve -> report loop be validated end to end
// without the driver auto-continuing to bet 2 in the same run -- matches
// where the retired Betfair build got stuck (bet 1 worked, never got bet
// 2 fully unstuck), so proving bet 1 solid first, deliberately, rather
// than debugging both at once. No effect on a real (non-test) job --
// stopping a real job after bet 1 would leave bet 2's real money never
// placed while still reporting the job "done."
const STOP_AFTER_FIRST_BET = process.env.STOP_AFTER_FIRST_BET === "1";

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

// Confirmed live (2026-09-23): waitUntil: "networkidle" never resolves on
// Betano within its 30s timeout, even on a page that's fully loaded and
// completely usable -- independently verified via a real browser check,
// not assumed from the timeout error alone. Betano almost certainly keeps
// some background traffic running continuously (live-odds polling,
// analytics), which "networkidle" (500ms of zero network activity) can
// never satisfy on this kind of page. Using "domcontentloaded" instead,
// paired with an explicit wait for a real, meaningful element -- a
// reliable substitute for "is this page actually usable yet."
async function gotoFixturesList(page) {
  await page.goto(EPL_FIXTURES_URL, { waitUntil: "domcontentloaded" });
  assertNotChallenged(page);
  await page.getByRole("button", { name: /^Bet on 1 with odds/i }).first().waitFor({ state: "visible" });
}

async function gotoMatchPage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  assertNotChallenged(page);
  await page.getByText("Match Result", { exact: true }).first().waitFor({ state: "visible" });
  // The marketing popup was only ever confirmed live on a fresh tab's
  // first navigation (see dismissMarketingPopup below), but it's cheap
  // and idempotent to check here too (no-ops instantly if not present) --
  // real runs after that fix still saw it reappear, and match-page
  // navigation is the other place a fresh page load could plausibly
  // retrigger it. Defensive, not yet confirmed as the actual explanation.
  await dismissMarketingPopup(page);
}

// Confirmed live (2026-09-24): Betano shows a dismissible "Available
// bonus" marketing popup (a modal wrapping an iframe pointing at
// /en/myaccount/marketingbonus) on every fresh browser tab -- exactly the
// "bonus/deposit popup" Winston already knew to dismiss with the X by
// hand during manual login. driver.js opens a brand-new tab every run
// (context.newPage()), which triggers this popup every single time, and
// nothing dismissed it before this fix. The modal physically intercepts
// pointer events (esc-close:false, bg-close:false -- can't be dismissed
// via Escape or a background click) and was the real root cause behind
// repeated click/stake-fill failures previously misattributed to other
// things (row-scoping, debounce timing) -- proved by reproducing the
// exact same 6-leg build + stake fill sequence twice on a genuinely fresh
// tab: it hard-timed-out at 30s with the modal up, then worked cleanly
// once the modal was dismissed first. Called once, right after the
// initial fixtures-list navigation, before building any bets -- doesn't
// reappear within the same tab/session once dismissed.
async function dismissMarketingPopup(page) {
  const modal = page.locator("#iframe-modal");
  if (!(await modal.isVisible().catch(() => false))) return;
  const bonusFrame = page.frameLocator("#iframe-modal iframe[src*='marketingbonus']");
  await bonusFrame.locator('img[alt="header header-times"]').click({ timeout: 5000 }).catch(() => {});
  await modal.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}

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
// Row-scoping fix, confirmed live (2026-09-23): the nearest-tr/li/div-
// ancestor heuristic borrowed from Betfair was wrong on two counts here --
// it stopped one level too shallow (Betano's fixtures list has no
// <tr>/<li> at all, so the link's immediate parent is already a plain
// div, matching the filter one level before the real row wrapper that
// actually holds the price controls), and it implicitly assumed native
// <button> tags, when Betano's price controls are actually
// `<div role="button">` (confirmed via the real accessibility tree --
// Playwright's getByRole("button", ...) still matches these fine, since
// it's role-based, but any tag-based DOM probing silently misses them).
// Fixed depth-agnostically: instead of a fixed ancestor depth/tag list,
// walk up from the link until the ancestor's subtree actually contains a
// role="button" descendant -- won't break if some other part of the site
// (e.g. live vs upcoming fixtures) nests things one level differently.
async function buildFixtureIndex(page, matchesNeeded) {
  await gotoFixturesList(page);

  const index = {};
  for (const { match, homeTeam, awayTeam } of matchesNeeded) {
    try {
      const link = page.getByRole("link", { name: new RegExp(`${escapeRegex(homeTeam)}.*${escapeRegex(awayTeam)}`, "i") }).first();
      const href = await link.getAttribute("href");
      const row = link.locator('xpath=ancestor::*[.//*[@role="button"]][1]');
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
  await gotoMatchPage(page, url);

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
// Betano's own EU number formatting (`.` thousands separator, `,`
// decimal) per BETANO_RECON.md section 5 -- e.g. "2.000,00" -> 2000. Never
// parse these figures as US-formatted numbers.
function parseEuNumber(s) {
  return Number(String(s).replace(/\./g, "").replace(",", "."));
}

// Returns the actual potential-return figure, parsed from BET NOW's own
// label ("BET NOW <stake> € Potential winnings <total> €" in Multiple
// mode, per BETANO_RECON.md section 5) -- null if the label doesn't
// contain a recognizable figure, so the caller can decide whether that's
// worth hard-failing over rather than silently reporting a wrong number.
async function fillStake(page, stake) {
  const stakeAmount = Number(stake);
  const stakeBox = page.locator(".bet-slip-container").getByRole("textbox").first();
  await stakeBox.fill(String(stakeAmount));
  // Verified via the BET NOW button's own label, which embeds the live
  // potential-winnings figure once a stake is entered (see
  // BETANO_RECON.md section 5) -- if it still reads as disabled/no amount,
  // the fill didn't register.
  //
  // Polled, not a single immediate check -- confirmed live (2026-09-23),
  // three separate reproductions: Betano debounces the label's
  // recomputation by roughly 300-500ms after the input changes. A single
  // read right after .fill() reliably catches the stale pre-debounce
  // value, which on a run's very first stake entry (empty -> a real
  // number) is the untouched disabled "BET NOW" label -- can never match
  // the regex, a false failure on a fill that actually worked. Polling up
  // to 2s is robust to render/network variance without guessing a fixed
  // sleep length.
  const betNow = page.getByRole("button", { name: /BET NOW/i });
  const pattern = new RegExp(String(stakeAmount).replace(".", "[.,]"));
  const deadline = Date.now() + 2000;
  let label = "";
  while (Date.now() < deadline) {
    label = await betNow.innerText().catch(() => "");
    if (pattern.test(label)) {
      const match = label.match(/Potential winnings\s*([\d.,]+)\s*€/i);
      return match ? parseEuNumber(match[1]) : null;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`Stake fill for ${stakeAmount} didn't appear to register on BET NOW's label after 2s: "${label}"`);
}

// Final live re-verification, right before ever reporting a build as
// ready for approval -- confirmed live (2026-09-24): a real run reported
// a clean awaiting_confirmation (SCREENSHOT_READY logged, relay payload
// posted) while the actual live betslip had already gone back to empty
// ("You have no open bets at this moment") and the saved screenshot came
// out blank. The relay payload is built from the driver's own in-memory
// `plan` object -- it was never re-checked against the live page at
// report time, so it can go stale (something resets the client-side
// selection state between the last successful click and the report)
// without the driver ever noticing. Harmless in test mode (approving just
// logs "simulating," nothing real happens), but this is exactly the
// failure shape that could let a broken/emptied slip get approved as if
// it were intact in real mode. Throws (caught by main()'s existing
// hard-stop path -- screenshot + relay error report) rather than
// reporting, if the live betslip doesn't actually contain every leg the
// plan expects.
async function verifyBetslipMatchesPlan(page, plan) {
  const snapshot = await betslipSnapshot(page);
  const missing = plan.steps.filter((step) => !selectionAppearsIn(snapshot, step.selection));
  if (missing.length) {
    throw new Error(`Betslip no longer matches the plan right before reporting -- missing ${missing.length} leg(s) (${missing.map((s) => `${s.match}: ${s.selection}`).join(", ")}). Betslip shows: "${snapshot}"`);
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
          await gotoMatchPage(page, knownUrl);
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
  return fillStake(page, plan.stake);
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

  try {
    // Navigate once, up front -- same lesson as Betfair's build: a brand-new
    // page.newPage() tab starts on about:blank, and clearBetslip() (called
    // at the top of the loop below, for every bet including Bet 1) needs a
    // real page loaded to check at all. Moved inside the try block on
    // purpose: a failure here used to skip the hard-stop screenshot + relay
    // error report entirely, leaving the job stuck "claimed" with zero
    // failure trace -- confirmed live (2026-09-23).
    await gotoFixturesList(page);
    await dismissMarketingPopup(page);

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

      const potentialReturn = await buildBetOnBetano(page, stagehand, plan, withAiFallback);
      await verifyBetslipMatchesPlan(page, plan);
      const screenshotPath = await takeScreenshot(page, player, label);
      await postAwaitingConfirmation(player, { stake: plan.stake, legs: plan.steps, skipped: plan.skipped, screenshotPath, betNumber: i + 1, potentialReturn });
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

      const isLastBet = i === bets.length - 1;
      const stopEarly = test && STOP_AFTER_FIRST_BET && i === 0 && !isLastBet;
      if (isLastBet || stopEarly) {
        if (stopEarly) console.log(`[betano-driver] STOP_AFTER_FIRST_BET set -- reporting ${player} done after bet 1 only, not building bet 2 this run.`);
        await reportPlaced(player, test);
        break;
      }
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
