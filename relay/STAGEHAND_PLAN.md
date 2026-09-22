# Plan: Replace OpenClaw's agentic browser loop with a mostly-deterministic Stagehand flow

## Why

Tonight's session (2026-09-18/19) proved the current approach — a general conversational
LLM agent (via OpenClaw's `agent:acca:main`) doing open-ended multi-step planning for every
Betfair placement run — is both too expensive (~$200+ in one debugging session) and too
unreliable (repeated "narrating instead of acting" stalls from GPT-5 mini, wrong browser
profile picked, Playwright click/type hangs, a real accidental live placement from a missed
env var). Cheaper chat models (Haiku, GPT-5 mini) were tried as drop-in replacements for the
agent's brain and both failed in different ways — Haiku couldn't reliably navigate search,
GPT-5 mini kept ending turns with only prose instead of calling a tool.

Root cause: asking a general chat-completion model to plan *and* execute a whole multi-step
browser job every run is the expensive, flaky part — not the browser automation itself.

Checked and ruled out: Betfair's own API can't replace browser automation for this — the
Sportsbook (fixed-odds accumulator) API is restricted to licensed affiliate partners only;
only the Exchange API (a different product) is open to individual accounts.

## The plan

1. **One-time deep recon pass** on Betfair Sportsbook's Premier League section. Map:
   - Where win/draw/lose markets can be picked directly from the main fixtures list
     (no need to open the match page for these).
   - What the match-page structure looks like for "special" markets (goals over/under,
     correct score, etc.) that do require opening the match page.
   - Actual selectors / DOM structure / navigation paths for all of the above.
2. **Save that map as a structured local reference file** — the source of truth the
   automation reads from, instead of an LLM re-discovering the page from scratch every run.
3. **Build the actual flow as real code** (Stagehand on top of Playwright, running against
   the existing local Chrome/Betfair-logged-in profile — not a cloud VM) against that
   reference:
   - Do all main-page-selectable win/draw/lose legs first, in bulk.
   - Then drill into match pages for the special-market legs.
   - This ordering minimizes page navigations (fewer chances to break, faster runs).
4. **AI only gets invoked for the ~10% the reference file doesn't cover** — an ambiguous
   team/match name, a missing market for a given fixture, or Betfair having changed
   something since the last recon pass. Candidate model: GPT-5 mini (cheap), but this time
   used for narrow, single-step decisions (Stagehand's `act`/`observe`/`extract` primitives)
   rather than open-ended multi-step planning — a structurally different, easier task than
   what caused tonight's stalls.
5. **If something doesn't match the reference file at all, flag it for Winston rather than
   guess.** That's the trigger to redo a small recon pass on just that piece, keeping the
   reference file current instead of silently drifting stale.
6. Anne/OpenClaw's role likely narrows to the notify-and-approve conversational layer
   (screenshots, "press confirm" pings) around this, rather than driving the browser itself
   — final split still TBD.

## Rough cost estimate (unverified until built)

- **Build (one-time):** ~$10-40 in Claude usage, depending on how many iterations the recon
  + scripting takes. Will track actual cost as we go rather than trust this estimate.
- **Per-bet, after built:** ~1-3 cents per bet (worst case maybe closer to a dime), assuming
  ~90% of the flow is plain deterministic code with zero LLM calls, and GPT-5 mini only
  handles the small remaining fraction. Will verify with real token/cost tracking once live,
  same as every other cost claim tonight.

## Status (last updated 2026-09-21)

**Step 1 (recon pass) is done.** OpenClaw/Anne ran a deliberate, unhurried
recon pass on Betfair Sportsbook (not Exchange) and the findings are saved in
`relay/SPORTSBOOK_RECON.md` — real URLs, selectors, and page structure for the
EPL fixtures list (Match Odds) and match pages (Over/Under Goals, Correct
Score), plus an important gotcha: legs from the same match silently switch
the betslip into "Bet Builder" mode instead of a normal accumulator, which
needs explicit detection (check the betslip tab reads "Multiples").

Also worth remembering from tonight, for context if it comes up again:
- Recon hit a Cloudflare Turnstile challenge once, triggered by a UI tab
  click (not direct URL navigation) — Winston cleared it manually once, and
  the resulting `cf_clearance` cookie on the persistent `betfair` browser
  profile prevented any repeat challenges for the rest of the session.
  Automating a click-through of that checkbox was explicitly requested by
  Winston and explicitly declined — that stays a hard stop requiring a human
  to clear it, not something to script around, regardless of account
  ownership. `TOOLS.md` on OpenClaw's side has this as a permanent rule.
- Scope is deliberately narrow: English Premier League only, Match Odds +
  Over/Under Goals + Correct Score only. Nothing else.

## Status (last updated 2026-09-22, end of third session -- stopped here, pick up next session)

**Where things actually stand right now**: the deterministic build path is
solid (Bet 1 -- always Match Odds only in this test data -- has now built
correctly, independently verified, on every single run for the last ~6
consecutive attempts). Bet 2 (which includes match-page picks: Correct
Score / Over-Under Goals) has hit a real, still-unresolved timing bug on
its Over/Under leg's "Show More" click, three times in a row, even after a
fix aimed directly at it. The very last diagnostic step (getting the exact
error from the third attempt, with the settle-wait fix applied) was cut off
mid-check by a session usage limit -- **that's the literal next thing to do
next session**: ask OpenClaw to re-check what error the third attempt
actually produced (it had already confirmed the leftover tab stayed
untouched -- tab-binding fix still holding -- but hadn't yet reported
whether the settle-wait fix changed the Show More timeout itself).

**Big confirmed win this session**: the long-open "does the AI fallback act
on driver.js's own tab or a different one" question is now definitively
resolved. Root cause found by reading the installed
`@browserbasehq/stagehand@2.5.9` source directly: `page` was never a real
constructor parameter in this version at all (silently dropped by JS
destructuring), and `Stagehand.init()` -- with no existing-page option
anywhere in its actual full parameter list (confirmed complete: env,
apiKey, projectId, verbose, llmProvider, llmClient, logger,
browserbaseSessionCreateParams, domSettleTimeoutMs, enableCaching,
browserbaseSessionID, modelName, modelClientOptions, systemPrompt, useAPI,
localBrowserLaunchOptions, waitForCaptchaSolves, logInferenceToFile,
selfHeal, disablePino, experimental) -- was activating whichever page
`context.pages()` happened to return first, which for most of tonight was a
leftover tab, not driver.js's own. Confirmed live twice with a screenshot:
once catching the fallback actually navigating the wrong tab, once
confirming a real fix (`stagehand.stagehandContext.getStagehandPage(page)`,
the actual public, intended override) left that same leftover tab
completely untouched on the next run. This was deliberately NOT fixed by
closing other tabs first, since that could close something Anne is
genuinely using.

### Every fix shipped this session, in order (all in `relay/betfair-automation/driver.js` unless noted)

1. Two-bet handling: `claimNextJob()` was using `.find()` and silently
   discarding the second of a player's two bet columns; `/next` already
   returns both (server-side filter). Switched to `.filter()`+sort.
2. Added the entire missing decision-wait lifecycle: `pollForDecision()`
   (same atomic `takeDecision()` endpoint Anne's poll always used),
   looped per-bet: build -> clear betslip -> screenshot -> report ->
   wait for decision -> reject clears the job and stops, approve
   continues to the next bet.
3. Added the Telegram hand-off contract (`SCREENSHOT_READY: <path>` log
   line) -- driver.js has zero messaging capability of its own, on
   purpose; something else has to watch for this line and act on it.
4. Explicitly refuses real-mode placement
   (`RealPlacementNotImplementedError`) rather than guessing at the Place
   Bet click -- stays unbuilt pending careful review.
5. **The actual empty-slip bug, found via extensive live diagnosis**:
   Betfair's price buttons are toggles (clicking an already-selected one
   deselects it); `clearBetslip()`'s old `.catch(() => {})` silently
   swallowed failures to actually clear. Fixed: `clearBetslip()` now
   verifies the slip reads empty and throws if not; every leg-click now
   verifies via a real betslip snapshot (`betslipSnapshot()`,
   `clickAndVerifyLeg()`) that the leg actually appears, retrying once
   before throwing.
6. Fixed `clearBetslip()` running before ANY navigation on Bet 1 (a
   brand-new tab starts on `about:blank`) -- navigate once before the
   per-bet loop starts, not inside it.
7. Fixed the stake never being filled at all (Potential Return always
   showed £0) -- then fixed AGAIN when the first attempt's `.first()`
   selector turned out to hit the Singles tab's stake box instead of the
   Multiples one (both coexist in the DOM regardless of active tab).
   Final, verified-working version anchors to the "Additional Multiples"
   heading.
8. Fixed Stagehand launching its own separate, unauthenticated throwaway
   browser (the blank-Chrome-window bug Winston kept noticing) --
   `cdpUrl` was left `undefined`; set to the same `CDP_URL` driver.js
   itself connects with.
9. Rebuilt Stagehand fresh per bet instead of once for the whole job --
   a `StagehandTargetClosedError` hit exactly at the Bet 1 -> Bet 2
   handoff after a real multi-minute idle wait in `pollForDecision`;
   theory is the CDP session isn't resilient to sitting idle that long.
10. Fixed a match-page URL bug (missing slash, produced
    `net::ERR_TUNNEL_CONNECTION_FAILED`) -- first with a manual fix, then
    properly with the real `URL` class for robust joining.
11. Added 10 total confirmed Betfair display-name overrides this session
    (Leeds United, Ipswich Town, Brighton & Hove Albion, Manchester
    United, Tottenham Hotspur, Nottingham Forest, Coventry City,
    Newcastle United, Hull City, Manchester City -- this last one
    inferred from a garbled report, worth a real re-confirm).
12. Added real verification to the AI fallback path itself -- it never
    checked whether its own claimed-successful `.act()` calls had
    actually added a leg; a run with 7 "successful" fallback calls later
    hard-stopped because too few legs had actually landed. Now checks the
    real page's betslip after every fallback call.
13. **The tab-binding fix** (see above, the big one) --
    `getStagehandPage(page)`.
14. Fixed the "Show More" button being completely unscoped (3 matching
    buttons existed on the page, causing a 30s ambiguous-actionability
    hang, not a clean error) -- anchored to the "Over / Under Goals"
    card's own heading.
15. Added an explicit wait for "0.5 Goals" (always visible by default)
    before attempting the Show More click, testing a settle-timing
    hypothesis -- **result of this specific test is what got cut off**,
    pick this up first next session.

### Known open items, not yet fixed

- **The Show More timing bug itself** -- still open as of this save, see
  above. Three consecutive Bet 2 attempts hit the identical failure
  signature (`waiting for getByRole('button', {name:'Over / Under
  Goals'})...Show More...`) despite the selector being independently
  re-verified correct and resolving instantly on a settled instance of the
  same page each time. Whether the settle-wait (fix #15) actually changes
  this is unconfirmed -- check first.
- **Potential Return / combined odds never reported to the relay** -- the
  app still shows £0 even on a fully correct build, because
  `postAwaitingConfirmation()`'s payload never included this figure.
  Winston flagged this; a selector was never actually nailed down (the one
  attempt got interrupted by a live race with Bet 1's approval). Still
  needs doing.
- **No Telegram screenshot has ever actually been sent** -- explained,
  not a bug: the Claude Code CLI session running all of tonight's tests
  has no Telegram-sending capability at all. `DRIVER_MANUAL.md` (written
  this session, lives in OpenClaw's `workspace-betfair` folder, not this
  repo) is the procedure for whoever DOES have that capability (Anne) to
  follow -- but Anne has not been the one running these tests tonight.
  This needs a real decision about who/what actually runs driver.js going
  forward.
- **Real placement (clicking Place Bet) is still entirely unimplemented**,
  on purpose -- stays that way until deliberately built and reviewed.
- **The trigger/integration question (task 3, original plan)** is still
  not fully decided -- `DRIVER_MANUAL.md` exists as a manual, on-demand
  procedure, deliberately not automated yet, given how many real bugs
  nearly every run has surfaced this session alone.

### Old status (superseded by the above, kept for history)

**Important correction to the two "successful" runs noted below**: both
were validated only by trusting driver.js's own reported success, never by
checking the live betslip. This session found (and fixed) a real bug where
a run could complete with zero errors while the betslip was actually
EMPTY -- so those two earlier runs should be treated as unverified, not
proven, until re-run with the fix in place. Root cause, confirmed live:
Betfair's price buttons are toggles (clicking an already-selected one
deselects it), and `clearBetslip()`'s old `.catch(() => {})` silently
swallowed any failure to actually empty the slip -- so leftover legs from a
prior run could cause this run's own "successful" clicks to toggle them all
back OFF. Fixed: `clearBetslip()` now verifies the slip actually reads
empty and throws if not; every leg-click now verifies via a real betslip
snapshot that the leg actually appears, retrying once before throwing. Also
added the full two-bet + wait-for-Winston's-approval + screenshot lifecycle
this session (was entirely missing before -- driver.js used to just exit
after posting the first bet). None of this (two-bet loop, decision-wait
loop, or the click/clear verification fix) has had a live end-to-end run
yet as of this update -- next session's first job is exactly that.

**Step 2 is built and has had two full successful end-to-end test runs**,
in `relay/betfair-automation/` (`betfairPlan.js` for the pure ordered-plan
layer, `driver.js` for the actual browser driving). Architecture ended up
different from the original guess in one big way, plus several real bugs
found and fixed only by actually running it live:

- **Doesn't launch its own Chrome profile** -- that was tried first and
  abandoned after real, repeated failures: the NordVPN extension wouldn't
  reliably land on GB across restarts (Brazil, then Portugal, on
  consecutive clean relaunches), plus the Chrome Web Store refusing to
  install extensions into Playwright's bundled Chromium. Switched to
  `chromium.connectOverCDP` against Anne/OpenClaw's own already-running,
  already-logged-in, already-GB-routed browser instead -- confirmed live
  this works cleanly, `driver.js` just opens its own new tab there.
- Real bugs found only through live testing, all fixed: Betfair displaying
  some teams under short/different names than the full official name
  (Leeds United->Leeds, Ipswich Town->Ipswich, Brighton & Hove
  Albion->Brighton, Manchester United->Man Utd, Tottenham Hotspur
  ->Tottenham -- see `BETFAIR_DISPLAY_NAME_OVERRIDES` in driver.js);
  `buildFixtureIndex` bypassing the AI fallback entirely and aborting the
  whole batch on one match's failure instead of isolating it; a missing
  `NordVPN extension dropped on launch` fix (`ignoreDefaultArgs`); a missing
  `stagehand.init()` call; `modelName` needing an `"openai/"` prefix for
  this Stagehand version; a process that never exited on its own (CDP
  WebSocket keeps a handle open); and, biggest one, `driver.js` originally
  skipped the actual queue-claim step (`/betfair-place-request/next`)
  entirely and went straight to a read-only export endpoint, so the final
  report-back 404'd -- fixed to claim properly, same as Anne's own poll
  always did.
- Cost tracking fixed too: `stagehand.metrics` (the raw aggregate) was
  shown to report identical token counts across different calls with
  different prompt lengths -- not plausible for genuine measurements.
  Switched to snapshotting metrics before/after each individual fallback
  call and summing real deltas, with the raw before/after pairs also kept
  in case `.metrics` turns out to reset per call rather than accumulate
  (still not confirmed either way -- needs a run that actually hits an
  unmapped name again to get real evidence).
- **Two full test runs** (both `test: true`, no real money): first needed 2
  AI fallback calls (Leeds United, Ipswich Town, before they were mapped) and
  succeeded; second was fully deterministic, zero fallback calls, zero AI
  cost -- exactly the "fallback rate trends to zero" goal.

## Real gaps found, NOT yet built -- pick up here next session

1. **No decision-consumer at all.** `driver.js` posts the bet to
   `awaiting_confirmation` and exits. Nothing watches for Winston's
   Approve/Reject afterward -- approving in the app right now just records
   a decision that sits there forever, untouched. Confirmed live: no cron,
   no launchd job, no live agent session exists anywhere that would pick
   this up (checked directly, not assumed).
2. **Only handles one of a player's two bets, silently.** Each player has
   two separate accumulator columns (Bet 1 and Bet 2, the original
   structure this whole project has always used), but `claimNextJob()`'s
   `.find()` grabs the first matching header for that player and ignores
   the second entirely. No mechanism exists for "approve bet 1 -> build and
   report bet 2." This is a real, silent gap, not just unfinished --
   whoever picks this up needs to fix `claimNextJob`/`betfairPlan.js` to
   handle both, not just notice the second one is missing.
3. **No Telegram screenshot/notification at all.** Winston's explicit
   requirement, stated after tonight's test runs: after building each bet,
   the flow should send a screenshot + message via Telegram (same as Anne
   always did), then genuinely pause and wait for the app approval -- not
   just silently post to the relay and exit. After approval, it should
   build and report the *second* bet the same way, wait again, and only
   then be done. None of this exists yet -- `driver.js` currently has zero
   Telegram/messaging capability, it's a silent CLI script.

Net: the deterministic build-and-report half works and is proven live. The
whole "wait for approval, notify, continue to bet 2" half -- which is most
of what actually makes this usable day-to-day -- doesn't exist yet. That's
the next real chunk of work, not a quick patch.

## Rough real cost data (from actual runs, not estimates)

- Fully deterministic run (all names already mapped): **$0.00**, zero LLM
  calls.
- Run needing 2 AI fallback calls (unmapped names): roughly 1383 prompt +
  32 completion tokens reported, under a tenth of a cent at GPT-5 mini
  pricing -- but that number came from the metrics tracking later proven
  unreliable (identical counts across different calls), so treat it as
  rough-order-of-magnitude only, not confirmed. The fix shipped this
  session (real per-call delta snapshotting) should give trustworthy
  numbers the next time the fallback actually fires.
