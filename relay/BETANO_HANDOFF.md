# Betano automation -- handoff / status (2026-09-25)

Full rewrite of the earlier 2026-09-23 handoff -- the milestone that doc was
building toward has now been reached. This is the current state to pick back
up from.

## The milestone: first genuinely complete, clean two-bet run

Confirmed end to end, independently verified (not just trusting logs):
- Bet 1: 6 legs, built correctly, approved by Winston in the app for the
  first time ever.
- Bet 2: 9 legs, including the "1-3" Correct Score pick that had hard-stopped
  every single prior attempt across multiple days -- built correctly on the
  deterministic click alone, **zero AI fallback needed on either bet**.
- Both Telegram hand-offs delivered successfully with correct screenshots
  (no black bars).
- Exit code 0. Queue empty. Environment clean afterward.

This closes out a genuinely long multi-day debugging saga. See "Full bug
history" below for the complete list of what was actually wrong and fixed
along the way -- useful context if anything regresses.

## Winston's three notes from this exact run -- next things to address

1. **Bet 2's screenshot doesn't fully fit all 9 legs.** Bet 2 accumulators
   run longer than bet 1's, and the current screenshot (cropped to the real
   content bounds via the `sharp` fix) may cut off legs that don't fit in
   the visible betslip panel on screen. Needs investigating -- possibly
   scrolling the betslip panel itself before capturing, or capturing in
   multiple scrolled segments, or just confirming whether Betano's own
   betslip UI scrolls internally and whether that's captured correctly.
2. **Real placement has never been tested.** `driver.js` deliberately
   hard-stops on approve in real (non-test) mode --
   `RealPlacementNotImplementedError`. Actually clicking the real BET NOW
   button is NOT implemented anywhere in this file, on purpose, pending
   deliberate review -- same standing rule as the retired Betfair driver.
   This is the next real conversation to have: what does "click BET NOW for
   real" actually need (confirmation UI, a point of no return, logging),
   and who reviews/approves adding it.
3. **Still navigating to the account-overview page after approval.** Same
   pattern noted a few times now -- this is very likely just OpenClaw's own
   habit of re-confirming login before/after significant steps (checking
   login always lands on `/overview`), not something `driver.js` itself
   does. Worth a final confirmation from OpenClaw that this is indeed
   routine housekeeping and not an unexplained side effect, just to close
   the loop on Winston's repeated observation of it.

## Full bug history (2026-09-23 through 2026-09-25)

Roughly chronological. Each of these was a real, live-confirmed bug, not a
guess -- full detail in `betano-automation/README.md`'s "Fixed, confirmed
live" section and individual git commit messages on `main`.

1. `networkidle` navigation timeout -- Betano's continuous background
   traffic means this never resolves; switched to `domcontentloaded` + an
   explicit element wait.
2. Hard-stop path gap -- initial navigation ran before the `try` block,
   skipping the hard-stop screenshot/report path entirely on failure.
3. `OPENAI_API_KEY` missing -- Stagehand validates it eagerly; resolved via
   a git-ignored `.env` + `--env-file=.env`.
4. Fixture-row scoping bug -- depth-agnostic ancestor walk instead of a
   fixed tr/li/div guess.
5. `fillStake` debounce race -- polled instead of a single immediate check.
6. Marketing bonus popup blocking every fresh tab -- `dismissMarketingPopup`
   added, later found to need calling far more defensively than originally
   thought (see #16).
7. Toggle-button race in `clickAndVerifyLeg` -- single click + poll instead
   of retry-clicking a toggle button.
8. Session Timer popup (real selector, real logout risk) -- confirmed live,
   handled via `dismissSessionTimer`, eventually wired into the per-leg
   loop, `pollForDecision`'s poll loop, and every match-page click site.
9. `verifyBetslipMatchesPlan` added -- re-verifies the betslip immediately
   before ever reporting `awaiting_confirmation`, closing a real
   false-success gap.
10. Telegram hand-off: local file path blocked by OpenClaw's own directory
    allowlist, then a base64-buffer workaround got silently truncated by
    exec's output-capture limit. **Real fix**: the relay itself now serves
    screenshots over HTTP (`POST`/`GET /betano-screenshot/...`, in-memory,
    capped at 20 entries), and `driver.js` uploads + hands back a real URL.
11. `clearBetslip` -- multiple rounds: `.first()` on "Remove selections"
    confirmed correct (not the bug); the real fix was retrying with popup
    dismissal, then (the actual root cause) trusting a polled container
    *count* instead of a racy `betslipSnapshot()` text read for success
    detection.
12. Screenshot black bars -- **two-stage fix**. A CSS-viewport `clip` was
    tried first and confirmed NOT to work (clip bounds the source region,
    not the output pixel density, which stayed locked at a wrong 2.0x
    `deviceScaleFactor`). Real fix: post-capture crop via `sharp`, using
    the live `window.devicePixelRatio` computed dynamically.
13. Session Timer needed checking *during* the per-leg build loop too, not
    just at navigation/post-build -- a real occurrence force-logged the
    session out mid-build, wiping 5 already-built legs.
14. Fixtures list URL missing matches -- swapped to `?bt=matchresult` for
    the full date window (the plain URL only showed a few days out, which
    looked like "bad data" for a real, valid Monday fixture).
15. Correct Score's "SHOW ALL" toggle for less-common scorelines was never
    wired in at all -- added, then **fixed again** when the first attempt
    used an unscoped page-wide search that could expand Over/Under's
    section instead of Correct Score's. Real fix: `marketCardFor()`, a
    depth-agnostic ancestor walk scoping to each market's own card.
16. `clickAndVerifyLeg`'s poll widened 2s -> 4s; `withAiFallback`'s own
    post-act() verification was a single unpolled read (the last unpolled
    check in the file) -- now polls too; `notifyHardStopDirect`'s Telegram
    caption could exceed Telegram's length limit on a large betslip -- now
    truncated safely.
17. **The actual root cause of the entire "1-3 sometimes works" saga**,
    found in two parts:
    - `executeMatchPagePick` only dismissed popups once at navigation, not
      before each subsequent click (expand, SHOW ALL, the actual pick) --
      a real popup blocking a click was directly observed and proven live
      (10+ second hang against `#iframe-modal`, resolved in 129ms once
      dismissed).
    - Even after that fix, failures continued -- the **real** root cause:
      `selectionAppearsIn` compared the raw scoreline (`"1-3"`) against
      betslip text that always renders WITH spaces (`"1 - 3"`), so
      verification could never succeed for Correct Score regardless of
      whether the click worked. Found directly from the code after Winston
      watched the driver correctly add "1-3" then go back and add a wrong,
      second pick for the same match. Fixed by normalizing dash-spacing in
      the comparison itself.
18. CDP port drift -- an OpenClaw app-level "Reset" click wiped the
    `betano` browser profile's live registration (Chrome data/login
    untouched, verified byte-identical) and separately wiped acca's own
    agent registration + Telegram binding. Both fully recovered via
    backup-then-reattach, verified non-destructive at every step. New port:
    8092 (was 8093) -- **confirm the current port before every run**, it
    can drift again.

## Operational lessons worth remembering

- **acca's own turn dies periodically from OpenAI rate limits**, especially
  right after a poll/check call. `driver.js` itself is unaffected and keeps
  running independently -- always verify against the raw session transcript
  log, never trust acca's own "Done" summary at face value. Confirmed
  multiple times this saga that acca's self-reports can be stale or
  outright fabricated (word-for-word content from an unrelated, much
  earlier run, despite being labeled "verbatim").
- **Check for orphaned `driver.js`/diagnostic-script processes** holding a
  stale CDP connection before trusting any run's results -- confirmed live
  that two processes sharing one browser tab produces confusing,
  hard-to-explain behavior.
- **The relay's screenshot store and job queue are both in-memory only** --
  a Render redeploy (which happens on every push to `main`) wipes both.
  Avoid pushing to `main` while a live test run has a pending screenshot
  that still needs reviewing.
- **`.env` credentials (`OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`) live in `betano-automation/.env`, git-ignored.** Never
  route raw secret values through any chat session -- get them set directly
  on the Mac.
- **Diagnostic logging is now in place** for the two popup types (every
  `dismissMarketingPopup`/`dismissSessionTimer` call logs a timestamped,
  labeled line) -- useful if anything popup-related resurfaces.

## Next steps, in order

1. Investigate bet 2's screenshot not showing all 9 legs (Winston's note
   #1 above).
2. Decide what real placement needs before ever implementing it (Winston's
   note #2) -- this is a real, deliberate conversation, not a quick code
   change.
3. Confirm with OpenClaw whether the post-approval overview-page navigation
   is genuinely just their own routine login check (Winston's note #3) --
   likely already true, just wants final confirmation.
4. Otherwise: the core build-and-approve loop for both bets is proven
   working. Future test runs should be genuinely routine now, barring a new
   edge case surfacing (a different market type, a different fixture
   pattern, etc.).
