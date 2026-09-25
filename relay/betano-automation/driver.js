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
// Confirmed live (2026-09-24): OpenClaw's own message tool refuses to
// attach a local file unless it's under one of two specific allowed
// roots (its own state/media directory, or the calling agent's workspace
// directory) -- confirmed by reading the installed package source, not
// guessed. driver.js's own default ("./screenshots", relative to this
// project folder) is neither, so PLACEMENT_MANUAL.md's Telegram hand-off
// fails on every single run until this is pointed somewhere allowed.
// Configurable rather than hardcoded to a specific agent's workspace path
// -- driver.js shouldn't need to know OpenClaw's own directory allowlist
// scheme, just where to put files so whatever's relaying them can reach
// them. Set to an absolute path under the agent's workspace when running
// via OpenClaw, e.g. /Users/winston/.openclaw/workspace-betfair/screenshots.
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "./screenshots";
// Last-resort hard-stop notification, added 2026-09-24: OpenClaw's own
// agent turn relaying SCREENSHOT_READY/HARDSTOP_SCREENSHOT_READY to
// Telegram is the primary, tested path -- but confirmed live that when
// that turn dies (a recurring OpenAI rate-limit issue this session) right
// as a hard stop happens, Winston gets zero notification at all. The
// failure sits silently until someone manually digs through raw logs.
// Both unset by design (opt-in, not required) -- if either is missing,
// notifyHardStopDirect() below just logs and does nothing, same as
// today's behavior; this is a fallback on top of the existing path, not
// a replacement for it.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
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
  await dismissSessionTimer(page);
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

// Confirmed live (2026-09-24), real selector from a real specimen (see
// BETANO_RECON.md section 10): a periodic responsible-gambling "Session
// Timer" popup (data-test-id="session-timer-v3", a plain
// <button>CONTINUE</button> inside it, no aria-label needed) with a live
// countdown to auto-logout -- confirmed to actually cause a real logout
// when the countdown expired before it got dismissed. Click immediately
// on detection, no delay -- the countdown can be down to a handful of
// seconds by the time it's even noticed. Idempotent no-op if not present,
// same pattern as dismissMarketingPopup.
async function dismissSessionTimer(page) {
  const timer = page.locator('[data-test-id="session-timer-v3"]');
  if (!(await timer.isVisible().catch(() => false))) return;
  await timer.getByRole("button", { name: "CONTINUE" }).click({ timeout: 5000 }).catch(() => {});
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

// Confirmed live (2026-09-24): .first() correctly targets the top-level
// clear-all button, not a per-leg one -- verified directly against a real
// 2-leg betslip: 3 elements match this locator (element #0 has no
// kb-trash-button/data-v- scoping and sits above the leg rows; #1 and #2
// share that scoping and sit at each leg's own row), and clicking
// .first() made .bet-slip-container disappear from the DOM entirely --
// not just drop to one leg. So "the container itself is gone" is the
// real, confirmed signal of a genuine clear, matching betslipSnapshot's
// own <error> fallback when the locator can't resolve at all.
//
// What was actually broken: this used to run right after
// pollForDecision's multi-minute idle wait -- the same kind of idle
// window that already let the Session Timer popup intercept clicks and
// wipe a session earlier this session -- with no popup dismissal before
// the click, and a silent .catch(() => {}) that swallowed any click
// failure without a trace. A popup blocking this exact click, unlogged,
// is the leading explanation for bet 1's legs surviving into bet 2's
// build.
//
// Fixed: dismiss both popups first, then retry the clear (dismissing
// again each attempt) up to 3 times, verifying via the real confirmed
// signal each time instead of a single silent click. Hard stops if it
// still isn't empty after that -- building bet 2 on top of bet 1's
// leftover legs is worse than stopping and asking for help.
async function clearBetslip(page) {
  const snapshot = await betslipSnapshot(page);
  if (!snapshot || /^<error/.test(snapshot)) return; // no betslip container at all yet -- nothing to clear
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dismissMarketingPopup(page);
    await dismissSessionTimer(page);
    await page.locator(".bet-slip-container").getByRole("button", { name: "Remove selections" }).first().click({ timeout: 5000 }).catch((err) => {
      console.warn(`[betano-driver] clearBetslip attempt ${attempt}: clear-click failed -- ${err.message}`);
    });
    const after = await betslipSnapshot(page);
    if (!after || /^<error/.test(after)) return; // container genuinely gone -- confirmed clear
    console.warn(`[betano-driver] clearBetslip attempt ${attempt}: betslip still present after clearing -- "${after}"`);
  }
  // Diagnostic added 2026-09-24: live investigation ruled out both the
  // original suspects (.first() targeting the wrong button, a popup
  // intercepting the click) via two clean manual reproductions -- the
  // real failure showed byte-for-byte identical betslip text across all
  // 3 attempts with zero click errors, which neither theory explains.
  // Leading unconfirmed hypothesis: the hard-stop screenshot visually
  // showed what looked like the entire page rendered twice, stacked
  // vertically -- if the real page ever ends up with two
  // .bet-slip-container elements (genuine DOM duplication, not a
  // screenshot artifact), the locator this function uses would silently
  // scope into an ambiguous/wrong copy, and a click could "succeed" while
  // the visible one never changes. Logging the real count right before
  // hard-stopping settles this definitively on the next occurrence,
  // without needing another live repro session.
  const containerCount = await page.locator(".bet-slip-container").count();
  console.error(`[betano-driver] clearBetslip diagnostic: ${containerCount} .bet-slip-container element(s) found in the DOM at hard-stop time.`);
  throw new Error(`clearBetslip: betslip still not empty after 3 attempts (${containerCount} .bet-slip-container element(s) found) -- refusing to build bet on top of it`);
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

// Confirmed live (2026-09-24), precisely, via a controlled single-click
// repro: Betano's price buttons are genuine toggles, same as Betfair's --
// clicking an already-selected button removes it. The retry loop this
// used to have was unsafe by construction as a result: an immediate
// post-click snapshot read can race ahead of the real re-render and
// report "not found" even when the click actually landed (confirmed:
// present at +0ms only as a stale pre-render read, gone from +100ms
// onward once toggled again) -- attempt 2 would then click the SAME
// button again, toggling OFF the leg attempt 1 had already correctly
// added, and the final check would then (accurately, by that point)
// report failure. This fully explained the recurring "AI fallback
// reported success but the leg never landed" pattern across several
// different legs -- not scattered misclicks, one systematic bug: a
// button whose real name is nested inside/near the row.
//
// Fixed the same way as fillStake's own debounce race: poll for up to 2s
// before ever deciding the click didn't register, instead of a single
// immediate check -- and never click the (toggle) button a second time
// just because a check raced ahead of the DOM.
async function clickAndVerifyLeg(page, button, matchLabel, selection) {
  await button.click();
  assertNotChallenged(page);
  const deadline = Date.now() + 2000;
  let snapshot = "";
  while (Date.now() < deadline) {
    snapshot = await betslipSnapshot(page);
    if (selectionAppearsIn(snapshot, selection)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`Click for ${matchLabel} ("${selection}") didn't add a leg to the betslip after 2s -- betslip shows: "${snapshot}"`);
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

// Confirmed live (2026-09-24): a local file path is useless to the relay
// (a Render service, not on this machine) and to the admin app, and both
// ways tried of handing a screenshot to OpenClaw's Telegram message tool
// directly failed structurally -- a local path is blocked by its own
// directory allowlist, and an inline base64 buffer built via exec gets
// silently truncated to ~10KB (nowhere near a real ~1.3MB base64
// screenshot), sending a corrupt fragment without erroring. Uploading to
// the relay, which is already a live public Node service, and handing
// back a real URL sidesteps both -- the message tool's own fetch
// mechanism is built to handle remote URLs as the primary case. This is
// deliberately best-effort: returns null (not a throw) on any failure, so
// a relay hiccup doesn't turn a successful bet-build into a hard stop --
// the local file and SCREENSHOT_READY log line remain the fallback.
async function uploadScreenshot(localPath) {
  try {
    const fs = await import("node:fs/promises");
    const buffer = await fs.readFile(localPath);
    const filename = localPath.split("/").pop();
    const res = await fetch(`${RELAY_URL}/betano-screenshot`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, dataBase64: buffer.toString("base64"), contentType: "image/png" }),
    });
    if (!res.ok) throw new Error(`betano-screenshot upload ${res.status}`);
    const { path } = await res.json();
    return `${RELAY_URL}${path}`;
  } catch (err) {
    console.error(`[betano-driver] Screenshot upload failed (non-fatal, local file/log line remain the fallback):`, err.message);
    return null;
  }
}

// Last-resort direct Telegram send on a hard stop -- see the
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID comment above for why this exists
// alongside (not instead of) OpenClaw's own relay. Uses Telegram's Bot
// API directly, passing screenshotUrl straight through as the `photo`
// parameter -- Telegram's own servers fetch it from the relay, so this
// needs no local file handling at all, sidestepping every problem the
// local-path/buffer approaches hit earlier. No-ops quietly (just a log
// line) if either env var is unset, or if the send itself fails for any
// reason -- this must never throw and turn a hard-stop's own error
// reporting into a second, worse failure.
async function notifyHardStopDirect(player, errorMessage, screenshotUrl) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error(`[betano-driver] Direct Telegram notify skipped -- TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set.`);
    return;
  }
  const caption = `🛑 Hard stop building a bet for ${player} (direct notify -- OpenClaw's own relay may not have gotten to this).\n\n${errorMessage}`;
  try {
    const endpoint = screenshotUrl ? "sendPhoto" : "sendMessage";
    const body = screenshotUrl
      ? { chat_id: TELEGRAM_CHAT_ID, photo: screenshotUrl, caption }
      : { chat_id: TELEGRAM_CHAT_ID, text: caption };
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(JSON.stringify(data));
    console.error(`[betano-driver] Direct Telegram notify sent (messageId: ${data.result.message_id}).`);
  } catch (err) {
    console.error(`[betano-driver] Direct Telegram notify failed:`, err.message);
  }
}

// Confirmed live (2026-09-24): a run reached awaiting_confirmation with a
// fully correct pendingBet payload (all 6 legs, right stake/return --
// verifyBetslipMatchesPlan had genuinely passed, immediately beforehand,
// in main()) and STILL sent Winston a completely blank screenshot --
// .bet-slip-container had vanished from the DOM entirely by the time
// this function's own .screenshot() call ran. Confirmed not a
// compositing artifact (element-scoped betslip screenshots of a real
// populated slip have rendered correctly all session) and not a stale
// download (the live page, checked directly afterward, matched the
// blank screenshot exactly). Something resets the client-side selection
// state in the narrow window between that verification and this
// function running -- root cause not yet found. Re-verifying here, as
// the very first thing this function does, collapses that race to the
// minimum possible (verify and capture now sequential, nothing else
// between them) and, more importantly, converts a silent false-success
// report into a proper hard-stop with an accurate error -- the same
// value verifyBetslipMatchesPlan's original call already provides for
// slower drift, just tightened to catch a wipe this fast too.
async function takeScreenshot(page, player, label, plan) {
  await verifyBetslipMatchesPlan(page, plan);
  const dir = SCREENSHOT_DIR;
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  const path = `${dir}/${player}-${label}-${Date.now()}.png`;
  // Confirmed live (2026-09-24), after an extensive misdirected hunt
  // (toggle races, Stagehand DOM instrumentation, zoom, CDP scale
  // overrides -- all ruled out): element-scoped .screenshot() on this
  // specific position:fixed widget is fundamentally broken in Playwright
  // and reliably produces a blank capture, full stop -- independent of
  // leg count, timing, or actual on-page state (verifyBetslipMatchesPlan,
  // a completely different code path checking .innerText(), was correct
  // every single time; only the pixel capture was broken). A plain
  // viewport screenshot (fullPage: false, NOT fullPage: true -- that one
  // still has the documented position:fixed stitching problem below)
  // captures the identical fixed-position content correctly, confirmed
  // directly. Every earlier "the betslip vanished" observation was
  // unrelated noise (checked well after the fact, on a tab that had since
  // had test-script interference), not a real second bug.
  //
  // Black bars on the right/bottom, confirmed and precisely quantified
  // live (2026-09-24), separate bug: these are raw CDP-attached tabs, not
  // Playwright-launched pages, so page.viewportSize() is null and
  // page.screenshot() falls back to sizing its capture buffer with a
  // hardcoded/default deviceScaleFactor of 2 -- but this profile's real
  // effective DPR is ~1.333 (native 2.0 retina x the 67% Chrome zoom set
  // by hand). Confirmed via CDP's Page.getLayoutMetrics(): real content
  // painted into a ~1996x1824 device-pixel area, while the PNG came out
  // 2994x2736 -- exactly cssLayoutViewport x 2, not x the real 1.333.
  // Fixed by clipping to the live CSS-pixel viewport size measured right
  // before capture, instead of depending on (or guessing) the DPR at all.
  const { width: cssW, height: cssH } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
  await page.screenshot({ path, fullPage: false, clip: { x: 0, y: 0, width: cssW, height: cssH } });
  console.log(`[betano-driver] SCREENSHOT_READY: ${path}`);
  const url = await uploadScreenshot(path);
  if (url) console.log(`[betano-driver] SCREENSHOT_URL: ${url}`);
  return { path, url };
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
    // Confirmed live (2026-09-24): the Session Timer can appear mid-build,
    // not just after fillStake or between navigations -- one real
    // occurrence covered the page and intercepted every click attempt on
    // a leg for 30+ seconds straight (the deterministic click retrying
    // against an overlay it couldn't get past), timed out, fell through
    // to the AI fallback (which also couldn't add the leg through the
    // same overlay), hard-stopped -- and the countdown expired during all
    // of this, force-logging the session out and wiping all 5 already-
    // built legs. Checking proactively before every single leg's click
    // attempt, not just reactively after something already went wrong.
    await dismissSessionTimer(page);
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
    // Winston observed, repeatedly, across multiple live runs: clicking
    // straight into the next leg with no pause after one lands doesn't
    // give Betano's own UI time to settle (the live-odds/betslip re-render
    // that follows each click) before the next click arrives. A flat 1s
    // pause between legs, every leg (not just list-picks -- match-page
    // picks get it too, on top of whatever navigation already took).
    await page.waitForTimeout(1000);
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

// Checks/dismisses the session-timer popup on every poll cycle (every
// intervalMs, 20s by default), not just on navigation -- confirmed live
// (2026-09-24) this popup can appear with the browser tab otherwise
// completely idle (nothing else touches `page` during this wait), which
// is exactly this function's whole purpose, and a real countdown expiry
// during exactly this kind of idle wait already caused a real logout
// once. `page` is optional so this stays testable/usable without a
// browser where it isn't needed.
async function pollForDecision(player, page, { intervalMs = 20000, logEveryMs = 300000 } = {}) {
  let lastLog = Date.now();
  console.log(`[betano-driver] SCREENSHOT_READY handoff above -- now waiting for ${player}'s approval in the app.`);
  for (;;) {
    const res = await fetch(`${RELAY_URL}/betfair-place-request/decision?player=${encodeURIComponent(player)}`);
    if (!res.ok) throw new Error(`betfair-place-request/decision ${res.status}`);
    const data = await res.json();
    if (data.decision) return data.decision;
    if (Date.now() - lastLog > logEveryMs) { console.log(`[betano-driver] Still waiting on ${player}'s decision...`); lastLog = Date.now(); }
    if (page) await dismissSessionTimer(page).catch(() => {});
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
    await dismissSessionTimer(page);

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
      // Root-caused, confirmed live (2026-09-24) via an independent
      // CDP-level navigation watcher outside driver.js's own process, not
      // just observed: a genuine top-level page reload occurs around when
      // fillStake() fires -- a real GET "Document" request to the exact
      // same fixtures-list URL, followed by fresh DOMContentLoaded/LOAD
      // events, not merely a DOM element reappearing. Cause of the reload
      // itself is still unknown (Betano's own doing, not driver.js's --
      // nothing else touches the page at that point), but the effect is
      // fully handled: Betano persists betslip selections across a reload
      // (confirmed, BETANO_RECON.md section 3), and this defensive
      // dismiss + the verifyBetslipMatchesPlan check right after already
      // recover from it cleanly -- confirmed end to end on a genuinely
      // clean run, all 6 legs intact post-reload. Kept here, right after
      // the build and before anything else, same idempotent
      // no-op-if-absent pattern as everywhere else these get called.
      await dismissMarketingPopup(page);
      await dismissSessionTimer(page);
      // Verified once here, right after the build (catches slower drift
      // early, before wasting time on a screenshot that's already
      // doomed), and again inside takeScreenshot itself, immediately
      // before capturing -- which check ends up throwing narrows down
      // roughly when a wipe happened, useful diagnostic signal until the
      // actual root cause (see takeScreenshot's own comment) is found.
      await verifyBetslipMatchesPlan(page, plan);
      const { path: screenshotPath, url: screenshotUrl } = await takeScreenshot(page, player, label, plan);
      await postAwaitingConfirmation(player, { stake: plan.stake, legs: plan.steps, skipped: plan.skipped, screenshotPath, screenshotUrl, betNumber: i + 1, potentialReturn });
      console.log(`[betano-driver] ${label} built and reported for ${player}.`);

      const decision = await pollForDecision(player, page);
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
    let failureUrl = null;
    try {
      const dir = SCREENSHOT_DIR;
      await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
      const failurePath = `${dir}/HARDSTOP-${player}-${Date.now()}.png`;
      // Confirmed live (2026-09-24): this path still used fullPage: true,
      // the same mode already documented (BETANO_RECON.md section 3) as
      // not compositing the position:fixed betslip widget correctly --
      // it never got the fullPage:false-plus-CSS-viewport-clip fix
      // takeScreenshot() got, so a hard-stop screenshot could show the
      // rest of the page fine while the betslip itself (often the most
      // relevant part) came out missing or malformed. Same fix, same
      // reasoning, applied here too.
      const { width: cssW, height: cssH } = await page.evaluate(() => ({
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      }));
      await page.screenshot({ path: failurePath, fullPage: false, clip: { x: 0, y: 0, width: cssW, height: cssH } });
      console.error(`[betano-driver] HARDSTOP_SCREENSHOT_READY: ${failurePath}`);
      failureUrl = await uploadScreenshot(failurePath);
      if (failureUrl) console.error(`[betano-driver] HARDSTOP_SCREENSHOT_URL: ${failureUrl}`);
    } catch (screenshotErr) {
      console.error(`[betano-driver] Could not capture hard-stop screenshot:`, screenshotErr.message);
    }
    // Fires regardless of whether the screenshot itself succeeded above --
    // even a text-only notification beats the silent-failure blind spot
    // this exists to close. Never allowed to throw (see the function's
    // own comment), so it can't turn this hard-stop path into a worse one.
    await notifyHardStopDirect(player, err.message, failureUrl);
    // Confirmed live (2026-09-24): a hard stop leaves the queue entry
    // stuck "claimed" -- nothing auto-releases it, blocking any future
    // job for anyone until someone notices and clears it manually.
    // Deliberately test-mode only: for a real job, auto-recycling the
    // claim back to available risks it getting re-claimed and rebuilt
    // from scratch after a hard stop that happened mid-real-placement --
    // same real-money duplicate-placement risk markAwaitingConfirmation's
    // own no-expiry design already guards against elsewhere. A test job
    // has no such risk (nothing real was ever placed), so auto-clearing
    // it is safe and removes real friction from testing.
    if (test) await clearJob(player).catch((clearErr) => console.error(`[betano-driver] Auto-clear after test-mode hard stop failed:`, clearErr.message));
    process.exitCode = 1;
  } finally {
    console.log(`[betano-driver] AI fallback used ${fallbackLog.length} time(s) across this job:`, fallbackLog);
    console.log(`[betano-driver] Real summed usage/cost this run:`, sumMetrics(fallbackLog.map((e) => e.metrics)));
    await page.close().catch(() => {});
  }

  process.exit(process.exitCode || 0);
}

main();
