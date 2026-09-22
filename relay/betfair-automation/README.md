# Betfair automation driver

Runs on the Mac (needs GB routing + a real Betfair login) -- NOT deployed to
Render, unlike the rest of `relay/`. Builds **both** of a player's weekly
accumulators (Bet 1, then Bet 2 -- this product's actual two-bet-per-player
structure) on Betfair Sportsbook using `../betfairPlan.js`'s ordered plan and
the page structure documented in `../SPORTSBOOK_RECON.md`, then reports each
built slip to the relay and **waits for Winston's approve/reject in the app
before continuing** -- screenshotting each slip and polling for the decision,
same lifecycle Anne always had, just via a script instead of an LLM agent
driving every click. It never clicks Place Bet itself in real mode (see
"Real placement" below).

## Status: proven live for the deterministic build+wait+two-bet flow

Two full end-to-end test runs succeeded (2026-09-22, both `test: true`, no
real money): one needed 2 AI fallback calls for then-unmapped team names,
the second was fully deterministic with zero AI cost. The two-bet loop and
decision-wait loop (this file's newest part) haven't had a live run yet as
of this edit -- write-time only, same caveat as everything untested here.

## Setup: connects to Anne/OpenClaw's browser, doesn't launch its own

History: an earlier version launched its own independent, persistent Chrome
profile with a from-scratch NordVPN + Betfair login. Abandoned
(2026-09-22) after real, repeated failures -- the NordVPN extension wouldn't
reliably land on GB across restarts (landed in Brazil, then Portugal, on
consecutive clean relaunches), each fresh profile needing its own setup
fight. Confirmed live via a standalone `connectOverCDP` test that
Anne/OpenClaw's already-running "betfair" browser is directly reachable and
already has working GB routing + login, so `driver.js` now reuses that
instead of maintaining a separate profile.

1. `npm install` in this folder.
2. Before running `driver.js`, Anne/OpenClaw's browser must already be
   running with its CDP port open (e.g. `openclaw browser start`) --
   `driver.js` connects to it, it doesn't start it.
3. Set `BETFAIR_CDP_URL` if it's not the default (`http://127.0.0.1:8092`).
4. Confirm `RELAY_URL` (env var, defaults to the deployed Render URL) is
   reachable from the Mac.

**Two real constraints this brings, not fully solved by this file alone:**
- Anne's browser needs to actually be logged in when `driver.js` connects --
  the login session doesn't survive a full process restart (only
  `cf_clearance` and the VPN extension's own state do), so a cold-started
  browser won't have a live session even though it's reachable.
- Concurrency: `driver.js` opens its own new tab rather than touching
  whatever tab Anne has open, but driver.js and Anne still shouldn't both be
  actively driving the browser at the same time -- see
  `../STAGEHAND_PLAN.md`'s status section on Anne's narrowing role.

## Running it

```
node driver.js
```

No player argument -- confirmed live (2026-09-22) this needs a real pending
request in the relay's queue first (the app's "place bet" button, or
`POST /betfair-place-request` manually), the same way Anne's own poll does.
`driver.js` claims whichever job `/betfair-place-request/next` hands back
(one-at-a-time serialization, same as always); there's no way to request a
specific player. An earlier version skipped this claim step entirely and
went straight to the read-only `/betfair-export`, which is why the very
first full run 404'd on the final report-back step -- there was never a
claimed entry for it to attach to.

For each of the (up to 2) bets in the claimed job, in order:
1. Clears whatever's in the betslip first (idempotent -- stops Bet 1's legs
   bleeding into Bet 2's build and merging into one wrong combined slip).
2. Builds the slip, screenshots it, logs `SCREENSHOT_READY: <path>`, and
   posts it to the relay as `awaiting_confirmation`.
3. **Polls `/betfair-place-request/decision` until Winston approves or
   rejects** in the app -- no timeout, matches `awaiting_confirmation`'s own
   no-expiry design (a real confirmation can take minutes or hours). Logs a
   heartbeat every 5 minutes so it's visibly still waiting, not stuck.
4. On reject: clears the job via `/betfair-place-request/clear`, stops --
   does NOT build any further bets for that job.
5. On approve, test mode: logs "simulating," does not click anything, moves
   on to the next bet (or reports fully placed if that was the last one).
6. On approve, real mode: **hard-stops on purpose.** Clicking the real
   Place Bet button is not implemented in this file at all -- see "Real
   placement" below.

**`driver.js` has no Telegram/messaging capability of its own.** The
`SCREENSHOT_READY: <path>` log line is the hand-off contract -- whatever
wraps this script (OpenClaw, per the pending integration decision) is
responsible for finding that path and actually sending the screenshot +
a notification to Winston. This was Winston's explicit requirement after
the first test runs: a real notification per bet, not a silent relay POST.

- Exits 0 and logs "No pending job" if the queue is empty -- nothing to do.
- Exits 0 on a fully successful job (every bet approved and reported).
- Exits 1 and logs the error on any hard stop -- including a genuine
  Cloudflare Turnstile challenge (never auto-clicked, per the project's
  standing rule), a same-match conflict (shouldn't happen given
  `betfairPlan.js`'s data shape, but checked for real on-page state anyway),
  or an approve in real mode (not implemented, see below).

## Real placement is NOT implemented

`buildBetOnBetfair` stops at "slip built, verified" and never clicks Place
Bet. On a real-mode approve, `main()` deliberately throws
`RealPlacementNotImplementedError` rather than guessing at that click.
Given this project's own history (a real accidental live placement earlier
from a missed env var), this needs careful, explicit implementation and
review before it exists -- not something to add casually alongside other
fixes.

## Known open questions for whoever tests this first

- ~~**Exact Stagehand wiring**~~ -- resolved (2026-09-22): confirmed live that
  `await stagehand.init()` is required after the constructor, before
  `.page`/`.act()` are usable. Now called in `driver.js`.
- **Selector accuracy**: every locator in `driver.js` (fixture row matching,
  price button positions, Correct Score scoreline rows, Over/Under goal
  lines) was written from `SPORTSBOOK_RECON.md`'s notes, not verified live.
  Run it against a real week's bets, watch where it needs the AI fallback,
  and tighten the deterministic locator for any step that falls back
  often -- the whole point of this design is that the fallback rate should
  trend toward zero as selectors get corrected, not stay a fixed 10%.
- **Integration/trigger**: partly decided -- `driver.js` now owns the full
  wait-for-approval, two-bet lifecycle itself (it didn't before this edit),
  so OpenClaw's job narrows to: (1) invoke it when a placement is due, (2)
  watch its stdout for `SCREENSHOT_READY:` lines and actually send that
  screenshot + a notification to Winston, and (3) relay a hard-stop failure
  to Winston the same way Anne does today. None of that wrapping exists
  yet -- see `../STAGEHAND_PLAN.md`'s status section.
- **Two-bet/decision-wait loop is untested live** -- written this session,
  not yet run against a real queue job. Watch specifically: does
  `clearBetslip`'s "Remove all" selector actually work (recon never tested
  it), does the poll loop actually pick up a decision recorded while it's
  mid-sleep, and does Bet 2 build cleanly after Bet 1's slip is cleared.
