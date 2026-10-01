# Betano automation -- handoff / status (2026-10-01)

Full rewrite of the 2026-09-25 handoff -- that milestone (first clean
two-bet run) has since been followed by every other test scenario Winston
asked to see proven before any real-money conversation could start. This is
the current state to pick back up from.

## The milestone: every pre-real-placement test scenario is now proven

All confirmed live, independently verified (not just trusted from logs):

1. **Clean two-bet build.** Both bets, all legs, zero AI fallback needed,
   correct screenshots, clean Telegram hand-off, exit code 0.
2. **Long multi-leg accumulators screenshot completely.** Betano's betslip
   scrolls internally past ~6-7 legs -- `driver.js` now captures one
   screenshot per scroll position and reports all of them; a real 9-leg bet
   confirmed covered across 2 screenshots, cross-checked leg-by-leg against
   the queue's own data.
3. **Combined odds and potential return are captured and shown correctly**,
   in both the app (`@ <odds>`, was permanently `?` before) and Telegram
   (was permanently showing `0`, root-caused to the figure never actually
   being logged anywhere before -- fixed with an explicit stdout summary
   line).
4. **The real Google Sheet write-back works end to end.** `writeSheetOnTest`
   (an explicit per-job opt-in) let the real `adminSetWinValue` path be
   proven on a test job, no real bet needed -- confirmed by reading the live
   DASHBOARD cells directly (Pepe's H18/I18 matched the driver's own
   potentialReturn figures exactly).
5. **Long-delay tolerance.** A real ~4-hour unattended wait for Winston's
   approval was survived cleanly, start to finish, by the queue and (once
   fixed -- see bug history) by `driver.js` itself.
6. **Crash-survival and hard-stop recovery, proven against three real,
   separate failure classes** that all surfaced during this testing round
   (see bug history #19-21) -- every one now ends in a proper Telegram
   notification and a released queue claim instead of a silently stuck job.
7. **Multi-player queueing**, proven twice: once for pure queue mechanics
   (exclusivity holds regardless of player, a second player's job sits
   untouched in `pending` the whole time the first is claimed/building/
   awaiting confirmation), and again with two players' genuinely different,
   independent real leg data (Pepe vs Timbo) built back to back with zero
   cross-contamination.

With all seven proven, the next real conversation -- what actually clicking
BET NOW for real needs -- can finally start. `RealPlacementNotImplementedError`
still hard-stops any real (non-test) approval; nothing changes there until
that conversation produces a deliberate plan.

## Bug history since the 2026-09-25 handoff

Roughly chronological; continues the numbering from the prior handoff
(1-18 there). Full detail in individual commit messages on `main`.

19. **Telegram hand-off depended on OpenClaw's own session staying alive.**
    A real run's bet 2 built and reported itself hours into an unattended
    wait, after OpenClaw's own agent turn had already ended -- Winston never
    got a Telegram message for it. Fixed the same way hard-stops already
    were: `driver.js` now sends the awaiting-confirmation hand-off directly
    via the Bot API itself (`notifyAwaitingConfirmationDirect`), alongside
    (not instead of) OpenClaw's own relay.
20. **Silent process death during an idle wait.** A real overnight run's
    Node process vanished with zero trace (no crash report, no system log
    entry) -- leading suspect: Node's default behavior kills the whole
    process on any unhandled promise rejection, and Stagehand/Playwright's
    own CDP connection can throw one from listeners outside `driver.js`'s
    own code during a long idle sit. Added `process.on("unhandledRejection"/
    "uncaughtException")` handlers that log and keep running instead.
21. **`connectOverCDP()` ran before `main()`'s own try block.** A real
    connection timeout (`Timeout 30000ms exceeded`) bypassed the entire
    hard-stop path -- no Telegram notify, no queue-claim release -- only
    caught by bug #20's new handler, which just logs and lets the process
    quietly end. Moved the connection/context/page setup inside the try
    block (same fix bug #2 already got for the fixtures-list navigation);
    `page` guarded in both `catch` and `finally` for the case where the
    connection itself is what failed, before `page` was ever assigned.
22. **`reportPlaced()` discarded `/betfair-place-result`'s own response
    body.** No log-based way existed to confirm whether a Sheet write
    actually succeeded -- verifying bug-history item 4 above required
    falling back to reading the live Sheet directly. Now logs the
    `outcomes` array.
23. **`verifyMultiple` mislabeled an empty betslip as a same-match
    conflict.** A hard stop reported `SameMatchConflictError` with a
    `betslipSnapshot()` that was itself just a locator timeout waiting for
    `.bet-slip-container` -- that element only exists once a real selection
    exists, so the timeout actually meant zero legs were ever added, a
    completely different failure shape from a real conflict. Now checks
    container presence directly and throws a distinct, accurate error.
24. **A long, ultimately-unnecessary investigation turned out to be a false
    alarm, root-caused to missing Sheet data, not a bug.** A real CDP
    connection got stuck (Playwright's handshake never completing, though
    plain HTTP/WebSocket-open both worked fine) after several days of a
    single long-lived Chrome process carrying heavy CDP traffic -- fixed by
    restarting the betano browser profile (operational, not a code fix;
    login/profile data preserved via the existing documented recovery
    procedure, confirmed via a Sept-25 backup after the registration
    deletion also deleted the live profile data, a real near-miss worth
    remembering -- **`delete-profile`-style commands can delete the actual
    user-data-dir from disk, not just the registration; always confirm a
    backup exists before running one**). The restart surfaced a genuinely
    new widget ("Bet Mentor") in the betslip sidebar, which triggered a long
    chase (reload persistence, login staleness, DOM mounting, geolocation
    errors) before the real cause was found: the two players being tested
    (Snackbar, Timbo) simply had zero bet picks entered in the Sheet that
    week. With an empty plan, the per-leg loop runs zero iterations and
    bug #23's accurate "betslip is empty" message is exactly correct --
    just confusing without checking the data first. **Lesson: check
    `legCount` on the actual exported bet data before investigating a
    "build" failure as a UI/site problem.**

## Operational lessons worth remembering (new this round)

- **A reflexive, unscoped habit can masquerade as a site bug.** OpenClaw's
  own pre-flight login check (and a redundant post-recovery confirm
  navigate) had been firing by default at the start of nearly every turn,
  14+ times across this round -- including, almost certainly, what Winston
  watched live and read as Betano's own UI misbehaving (a manual
  investigative reload, not a real `driver.js` run; confirmed via a 12-hour
  timestamp gap between the two). Cut back to only checking login
  immediately before an actual run. When something looks flaky, rule out
  "did a human or agent just poke the same browser tab" before concluding
  it's the target site.
- **Reload DOES persist selections, as `BETANO_RECON.md` already
  documented** -- an assumption to the contrary, made during rushed/
  uncontrolled manual testing, briefly looked like new evidence of a site
  regression. Re-confirmed live, carefully, that the original documented
  behavior still holds.
- **`delete-profile`-style browser commands can be destructive to actual
  user data, not just a registration pointer** -- confirmed live this round
  (see bug #24). Always verify what a "reset registration" command actually
  touches on disk before running it, and confirm a backup exists first.
- **The relay's queue and screenshot store are both in-memory, wiped by
  every push to `main`** (Render auto-redeploys on every push) -- this bit
  multiple times this round (a lost pending screenshot, a lost queue entry
  mid-retry). Always confirm the queue is genuinely clear before pushing,
  not just assume based on the last message.
- Everything from the 2026-09-25 handoff's own lessons section still holds
  (acca's turn dying from rate limits, orphaned-process risk, `.env`
  credential handling) -- not repeated here, see that section above.

## Next steps, in order

1. **The real-placement conversation** -- what actually clicking BET NOW
   for real needs (confirmation UI, a point of no return, logging, who
   reviews/approves it) before `RealPlacementNotImplementedError` is ever
   replaced with real code. Starting now.
2. Otherwise: every mechanical piece (build, screenshot, approve/reject,
   queue serialization, Sheet write-back, crash recovery) is proven working
   under real conditions. Future test runs should be routine, barring a
   genuinely new edge case.
