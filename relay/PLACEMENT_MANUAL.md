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
4. Check for orphaned `driver.js`/diagnostic-script processes still
   holding a CDP connection into the same browser profile --
   `ps aux | grep "[n]ode.*driver.js"` (and similarly for any leftover
   `_check_*.mjs`/`_test_*.mjs` scripts from earlier debugging). Confirmed
   live (2026-09-24): a driver.js process from ~6 hours earlier was still
   alive, parented by openclaw-gateway with no matching queue entry,
   sharing the same CDP session as the run actually being tested --
   two processes on one tab is exactly the kind of thing that can produce
   confusing, hard-to-explain DOM behavior. Kill anything stale before
   trusting a run's results.
5. **Confirm the actual CDP port the `betano` profile is currently
   registered on.** Confirmed live (2026-09-25): this can drift -- an
   OpenClaw app-level "Reset" click wiped the browser profile's live
   registration entirely (the underlying Chrome data was untouched, but
   re-registering it via `create-profile` assigned a new port, 8092, not
   the original 8093 `driver.js` defaults to). Check
   `openclaw browser list` (or equivalent) before assuming the default is
   still correct, and pass `BETANO_CDP_URL` explicitly if it's changed.

## Running

```
cd relay/betano-automation
STOP_AFTER_FIRST_BET=1 BETANO_CDP_URL=http://127.0.0.1:8092 SCREENSHOT_DIR=/Users/winston/.openclaw/workspace-betfair/screenshots node --env-file=.env driver.js
```

`BETANO_CDP_URL` above reflects the port confirmed live on 2026-09-25
(8092, after a profile re-registration) -- confirm this is still current
per step 5 above before relying on it; it can drift again.

Add `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` to that same `.env` (not the
inline command -- they're already loaded via `--env-file=.env`) for the
direct hard-stop notification, per `betano-automation/README.md`'s Setup
step 6. Optional, but closes a real blind spot: if this session's own
agent turn dies at the wrong moment, this is the only thing that still
notifies Winston at all.

`STOP_AFTER_FIRST_BET=1` is deliberate, for right now: the driver reports
the job fully done after bet 1 is approved instead of auto-continuing to
build bet 2 in the same run. Drop it once bet 1's full loop (below) has
been proven clean and we're ready to bring bet 2 back in -- see
`betano-automation/README.md` for what it does exactly.

`SCREENSHOT_DIR` is still worth setting (costs nothing, keeps screenshots
out of the project folder), but **it's no longer what the Telegram
hand-off depends on** -- superseded by the URL-based fix below.

**History, for context (both attempts genuinely failed, confirmed live
2026-09-24 by reading acca's own raw session transcript, not the
wrapper's summary -- don't retry either of these):**
1. A local file path was rejected outright: "not under an allowed
   directory," including one pointed at `SCREENSHOT_DIR` set to acca's own
   workspace directory, which should have been allowed per the message
   tool's own `getAgentScopedMediaLocalRoots` logic but wasn't --
   apparently `params.mediaLocalRoots` isn't populated correctly at that
   call site. A real gap in OpenClaw's own platform wiring, not anything
   fixable from this repo.
2. An inline base64 buffer, built via `base64 -i <file>` through exec, was
   silently truncated to ~10KB by exec's own output-capture limit -- a real
   ~1.3MB base64 screenshot never survived intact, so Telegram got a
   corrupted/unusable image fragment (or nothing) even though the send
   call itself reported success.

**The actual fix: `driver.js` now uploads every screenshot to the relay
and hands back a real, publicly reachable URL** (`SCREENSHOT_URL:`/
`HARDSTOP_SCREENSHOT_URL:` log lines, alongside the existing local-path
ones) -- the relay is already a live Render service, unlike the Mac
`driver.js` runs on, so this sidesteps both the local-path allowlist and
the exec truncation ceiling at once. Give the message tool this URL
directly (whatever its own remote-URL delivery mechanism is), not a local
path or a buffer.

## Step 1 -- the screenshot hand-off

Watch the driver's own log output for:

```
[betano-driver] SCREENSHOT_READY: <path>
[betano-driver] SCREENSHOT_URL: <url>
```

The moment `SCREENSHOT_URL` appears, **send that URL to Winston via
Telegram** (the local path is upload-best-effort -- if `SCREENSHOT_URL`
didn't appear, the upload itself failed; check the driver's own error log
for why before falling back to anything else), with a short caption:
player name, bet number, stake, and the potential return (same figure
that's also going into the app -- read it back from the relay's
`/betfair-place-request/queue` response, `pendingBet.potentialReturn`, so
the Telegram message and the app agree). This is the actual point of
`STOP_AFTER_FIRST_BET` and the `potentialReturn`/`screenshotUrl` fixes --
Winston should be able to look at the Telegram message and the app's
Approve/Reject screen (which now shows the same screenshot inline, per
`admin.html`'s `renderPendingBet`) and see the same real bet in both
places, not just a bare "check the app" prompt.

If a hard stop happens instead (`HARDSTOP_SCREENSHOT_READY:`/
`HARDSTOP_SCREENSHOT_URL:` in the log), send that URL too, with the actual
error message from the log -- don't let Winston find out some other way
that a run failed.

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
