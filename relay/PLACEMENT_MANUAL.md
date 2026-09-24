# Placement manual (Betano)

For OpenClaw's `acca` agent: what to actually do around a `driver.js` run,
beyond just executing it -- the Telegram hand-off and decision wait that
`driver.js` itself has no capability to do. Revives the pattern of the
retired Betfair-era `PLACEMENT_MANUAL.md`/`DRIVER_MANUAL.md` (both
referenced by name in `betfairQueue.js`/`server.js`'s own comments, deleted
during the Betfair cleanup, rewritten here for Betano), scoped down for
right now per Winston's own ask: **prove bet 1's full loop end to end
before bringing bet 2 back in** -- exactly where the Betfair build got
stuck (bet 1 worked, bet 2 never got fully unstuck).

## Before running

1. Confirm the `betano` browser profile is logged in -- **screenshot
   check, not an immediate post-reload state read** (that's raced false
   more than once). See `BETANO_RECON.md` section 9 for the recovery
   procedure if it's logged out.
2. Check `/betfair-place-request/queue` -- `getNext()` returns nothing if
   *anything* is already claimed/awaiting-confirmation, not just for the
   player you're testing. Clear a stale entry first if there is one.
3. Queue a fresh job if the queue's empty: `POST /betfair-place-request`
   with `{"player": "<name>", "test": true}`.

## Running

```
cd relay/betano-automation
STOP_AFTER_FIRST_BET=1 SCREENSHOT_DIR=/Users/winston/.openclaw/workspace-betfair/screenshots node --env-file=.env driver.js
```

`STOP_AFTER_FIRST_BET=1` is deliberate, for right now: the driver reports
the job fully done after bet 1 is approved instead of auto-continuing to
build bet 2 in the same run. Drop it once bet 1's full loop (below) has
been proven clean and we're ready to bring bet 2 back in -- see
`betano-automation/README.md` for what it does exactly.

`SCREENSHOT_DIR` is required for the Telegram hand-off below to actually
work -- confirmed live (2026-09-24): OpenClaw's message tool only accepts
local media paths under two roots (its own state/media directory, or the
calling agent's own workspace directory), and driver.js's default
(`./screenshots`, relative to its own project folder) is neither. Point
it at somewhere under acca's workspace directory -- adjust the path above
if that's not actually `/Users/winston/.openclaw/workspace-betfair/`.

## Step 1 -- the screenshot hand-off

Watch the driver's own log output for:

```
[betano-driver] SCREENSHOT_READY: <path>
```

The moment this appears, **send that screenshot file to Winston via
Telegram**, with a short caption: player name, bet number, stake, and the
potential return (same figure that's also going into the app -- read it
back from the relay's `/betfair-place-request/queue` response,
`pendingBet.potentialReturn`, so the Telegram message and the app agree).
This is the actual point of `STOP_AFTER_FIRST_BET` and today's
`potentialReturn` fix -- Winston should be able to look at the Telegram
message and the app's Approve/Reject screen and see the same real numbers
in both places, not just a bare "check the app" prompt.

If a hard stop happens instead (`HARDSTOP_SCREENSHOT_READY: <path>` in the
log), send that screenshot too, with the actual error message from the
log -- don't let Winston find out some other way that a run failed.

## Step 2 -- wait for the decision

`driver.js` polls `/betfair-place-request/decision` on its own (every
20s, heartbeat logged every 5 minutes) -- nothing for you to do here but
wait for Winston to press Approve or Reject in the app. No timeout on this
wait by design; a real decision can reasonably take minutes or hours.

## Step 3 -- report back

Once the driver exits (0 = success, 1 = hard stop), report the outcome
plainly: what happened, matching the driver's own log, not a summary that
smooths over anything. Same discipline as every diagnosis so far this
project -- verify against the real state (the app's queue, the actual
screenshot file, the live page if anything looks off), don't just relay
the log as ground truth. `verifyBetslipMatchesPlan` (added 2026-09-24)
already catches a mismatch between what the driver thinks it built and
what's actually on screen before it ever reports `awaiting_confirmation`
-- but if anything about the outcome doesn't fully add up, check the real
page yourself before calling it clean, the same way that verification step
itself was born from someone doing exactly that.
