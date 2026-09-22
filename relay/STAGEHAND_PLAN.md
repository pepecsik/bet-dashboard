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

## Status (last updated 2026-09-22, later same session)

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
