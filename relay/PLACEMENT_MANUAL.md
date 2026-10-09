# Placement manual (Betano)

**As of 2026-10-02, routine weekly operation no longer depends on anyone
(human or agent) reading this doc on a schedule.** `poll.js` now handles
noticing a new job and invoking `driver.js` deterministically, with no
model in that loop at all (see `betano-automation/README.md`'s own
section on why that changed -- the previous LLM-based cron job reading
this manual every ~30s was the actual root cause of a whole week-plus of
real bugs). `driver.js` itself now also sends its own Telegram hand-offs
directly (`notifyAwaitingConfirmationDirect`/`notifyHardStopDirect`/
`notifyRealPlacementDirect`), so most of what this doc originally existed
to tell an agent to do by hand is now just... what the code already does
on its own.

This doc's remaining job: a reference for a **human** doing a deliberate
manual test, or for OpenClaw helping debug a hard-stop Winston's flagged --
not a script for a scheduled tick to follow. If you're an agent reading
this because a cron job told you to, stop and re-read
`betano-automation/README.md`'s "Running it continuously" section first --
you're very likely the exact problem this update was written to prevent.

For OpenClaw's `acca` agent: what to actually do around a `driver.js` run,
beyond just executing it -- the Telegram hand-off and decision wait that
`driver.js` itself has no capability to do. Revives the pattern of the
retired Betfair-era `PLACEMENT_MANUAL.md`/`DRIVER_MANUAL.md` (both
referenced by name in `betfairQueue.js`/`server.js`'s own comments, deleted
during the Betfair cleanup, rewritten here for Betano), scoped down for
right now per Winston's own ask: **prove bet 1's full loop end to end
before bringing bet 2 back in** -- exactly where the Betfair build got
stuck (bet 1 worked, bet 2 never got fully unstuck).

## Relay base URL

**`https://bet-dashboard-relay.onrender.com`** -- every endpoint below
(`/betfair-place-request/queue`, `/betfair-place-request/next`, etc.) is
written as a bare relative path, same as the code itself (`driver.js`'s own
`RELAY_URL` constant defaults to this exact host). Confirmed live
(2026-10-02): a genuinely cold cron tick, with no accumulated conversation
context to fall back on, guessed `http://localhost:3001` here and failed --
don't guess, this is the real one.

## NEVER use a caching fetch tool against these endpoints

**Every GET/POST against this relay MUST go through a method that never
caches** -- `exec` + `curl -s`, not a generic "fetch a URL" tool. Confirmed
live (2026-10-02), a real failed placement attempt, found by directly
inspecting the session transcript, not inferred: the
`betfair-placement-poll` cron picked OpenClaw's own `web_fetch` tool to
check the queue, and `web_fetch` cached the very first response
(`{"job": null}`, `"cached": true`, a single `fetchedAt` timestamp).
Every one of the next 26 ticks across that session's entire 13-minute life
-- spanning the exact window Winston's real bet sat claimable in the
queue -- returned that identical stale response. The cron never looked at
the live queue again after its first glance; a real, valid, fully-formed
job sat there the whole time, invisible. **This endpoint's whole reason to
exist is that it changes by the second; any caching layer between an
agent and it is fatal, silently, with no error anywhere to notice.**

## NEVER call GET /betfair-place-request/next for inspection -- it claims on read

**This is the single most dangerous mistake to make with this relay, and
it already caused a real failed placement.** `/next` is NOT a read-only
peek -- every successful call to it atomically CLAIMS whatever job it
returns (see `getNext()` in `betfairQueue.js`: it flips the entry's status
to `"claimed"` as a side effect of being read). Only `driver.js`'s own
internal `claimNextJob()` is ever authorized to call it. **For any
inspection, pre-flight check, or "let me see what's queued" look -- by a
human or an agent -- always use `GET /betfair-place-request/queue`
instead**, which is genuinely read-only and never changes anything.

Confirmed live (2026-10-02): a cron tick's own pre-flight step called
`/next` directly to "see what's there," which silently consumed the job's
one-time claim right then. By the time `driver.js` ran moments later and
called `/next` itself (correctly, via its own internal logic), there was
nothing left to claim -- it logged "No pending job in the queue" and
exited cleanly, even though a real job had been sitting there seconds
earlier. Nothing crashed, nothing errored -- the job was just silently
gone. This single mistake, not any of the other fixes in this doc, was
the actual reason a real, fully-formed, pre-existing job produced zero
visible activity. The one historical mention of calling `/next` directly
elsewhere in this file (the caching investigation above) was a one-off,
out-of-band diagnostic action taken deliberately to isolate a bug --
**never a step to repeat or pattern-match onto during normal operation.**

## NEVER post a decision on Winston's behalf

`POST /betfair-place-request/decision` (approve/reject) is exclusively
Winston's own action, taken through the app. Confirmed live (2026-10-02):
an agent, confused mid-tick after the `/next` mistake above, attempted to
POST a `"reject"` decision on a job directly, apparently trying to "clean
up" what it thought was a stuck state. The relay's own validation happened
to block it (the job wasn't actually `awaiting_confirmation` at that
moment), so nothing was actually rejected this time -- but that's luck,
not a safeguard to rely on. Never call this endpoint for any reason other
than relaying a decision Winston has already made.

## Before running

**This whole section is for a human (you or Winston) deliberately walking
through a manual test, NOT for an automated/scheduled poll tick.**
Confirmed live (2026-10-02): the `betfair-placement-poll` cron job follows
this manual verbatim, and on an empty queue, Step 3 below reads as an
instruction to invent and queue its OWN fake test job, then actually run
`driver.js` against it -- a real, confirmed bug (a self-manufactured
`TestPlayer` job was found and traced directly to this). **An automated
poll tick must NEVER queue a job itself.** If `GET /betfair-place-request/
next` returns `{"job": null}`, that means there's nothing to do --
silently complete, exactly like any other empty-queue tick, and do not
proceed to Step 3. Step 3 only applies when a human has explicitly asked
for a test run to be set up.

1. Confirm the `betano` browser profile is logged in -- **screenshot
   check, not an immediate post-reload state read** (that's raced false
   more than once). See `BETANO_RECON.md` section 9 for the recovery
   procedure if it's logged out.
2. Check `/betfair-place-request/queue` -- `getNext()` returns nothing if
   *anything* is already claimed/awaiting-confirmation, not just for the
   player you're testing. Clear a stale entry first if there is one.
3. **(Human-initiated manual test only -- never for an automated poll
   tick, see above.)** Queue a fresh job if the queue's empty:
   `POST /betfair-place-request` with `{"player": "<name>", "test": true}`.
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

**As of 2026-09-28, `driver.js` also sends this hand-off directly to
Telegram itself** (via `notifyAwaitingConfirmationDirect`, same
TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID env vars as the existing hard-stop
notify) -- root-caused, confirmed live: a real run's bet 2 built and
reported itself hours into an unattended overnight wait, after acca's own
agent turn had already ended (having relayed bet 1's hand-off and then
stopped watching). Winston never got a Telegram message for bet 2 at all --
he had to approve it in the app blind. This still doesn't replace your own
relaying below -- keep doing it, a duplicate message is a far smaller
problem than a missing one, and driver.js's direct send has no way to add
context you might have (nor does it replace Step 3's report-back) -- but it
does mean Winston should now get SOME Telegram message for every bet
regardless of whether your own turn is still alive to catch it.

Watch the driver's own log output for one or more `SCREENSHOT_URL` lines
-- a long accumulator can produce more than one, confirmed live
(2026-09-25): Betano's betslip legs list scrolls internally once it has
enough legs, and since the betslip panel is position:fixed (bounded by
the real viewport no matter what), a single screenshot can only show
whatever's currently scrolled into view. `driver.js` now captures one
screenshot per scroll position and reports all of them:

```
[betano-driver] SCREENSHOT_READY: <path>
[betano-driver] SCREENSHOT_URL: <url>
[betano-driver] SCREENSHOT_READY: <path2>
[betano-driver] SCREENSHOT_URL: <url2>
... (one pair per screenshot -- could be just one, could be several)
```

**Send every `SCREENSHOT_URL` from this bet to Winston via Telegram** --
as separate photos, or however your message tool handles multiple images
in one send, but don't drop any of them; each one may show legs the
others don't. (The local path is upload-best-effort -- if a
`SCREENSHOT_URL` line is missing for a given `SCREENSHOT_READY`, that
specific upload failed; check the driver's own error log for why before
falling back to anything else.) Include a short caption: player name, bet
number, stake, and the potential return.

**Root-caused, confirmed live (2026-09-28): every prior Telegram caption
reported the potential return as 0**, because that figure was never
actually logged anywhere before now -- it only ever lived inside the JSON
body posted to `/betfair-place-request/awaiting-confirmation`, which
nothing was reading. `driver.js` now logs it directly, right after
`SCREENSHOT_URL`, in the same plain-stdout-line pattern that's already
proven to reach the Telegram hand-off reliably (unlike the JSON body):

```
[betano-driver] bet1 summary: stake €2 @ 3.68 -- potential return €7.36
```

Use these numbers for the caption -- don't reconstruct them from the JSON
response. `@ <odds>` is standard betting shorthand for "at these combined
odds," not a placeholder -- if it ever reads `@ ?` instead of a real
number, that means `extractCombinedOdds()` failed to parse the betslip's
own combo label (a real parse miss, not expected in normal operation) --
flag it back to Winston rather than treating it as routine. The app now
shows this same combined-odds figure too (`pendingBet.combinedOdds`, per
`admin.html`'s `renderPendingBet`), so the Telegram message and the app
should always agree; the app itself also shows every screenshot inline via
`pendingBet.screenshotUrls`, and clicking any screenshot in the app now
enlarges it (previously view-only at a small fixed size).
Winston should be able to look at the Telegram messages and the app's
Approve/Reject screen and see the same real bet, every leg included, in
both places -- not just a bare "check the app" prompt, and not a
partial view that's missing legs scrolled out of frame.

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

## Real placement (non-test jobs)

`driver.js` now actually clicks the real BET NOW button on an approved,
non-test job -- see `placeRealBet()`. **One thing MUST be confirmed live
before this is ever run for real**: `BALANCE_SELECTOR` (currently a
placeholder, `[data-test-id='balance']`, UNVERIFIED) must point at the
real account-balance element in the top nav (shown next to DEPOSIT once
logged in, e.g. "28,00 €"). Confirm the actual selector live, then set it
via `BETANO_BALANCE_SELECTOR` in `.env` (or pass it inline) before the
first real run -- do NOT let this run for real against the placeholder.
If the selector is wrong, the balance read right before the click fails
and hard-stops safely (before BET NOW is ever clicked) -- but confirm it
properly rather than relying on that as the plan.

**Verification method is balance-only, per Winston's explicit choice**:
balance before the click, compared against (balance before − stake) after
the click, polled for up to 15s. No reliance on any assumed Betano
"success" message -- nobody has ever seen what that looks like for real,
since every run before this was test mode.

**If a real placement comes back unverified (`RealPlacementUnverifiedError`,
falls through to the normal hard-stop path -- screenshot + direct Telegram
notify), do NOT click BET NOW again yourself, and do NOT tell driver.js to
retry.** A second click risks a genuine double placement -- strictly worse
than an unresolved one. Check the real account balance and open-bets list
manually, report exactly what you find to Winston, and let a human decide
what happens next. This is the one place in the whole system where
"investigate and retry" is the wrong instinct.

**On a verified success**, Winston gets a simple, separate Telegram text
message (no screenshot) straight from `driver.js` itself --
"✅ `<player>` bet `<N>` is successfully placed on Betano." That's
deliberately all he asked for; no further confirmation needed from you on
top of it.

The admin app's Approve/Reject card now also shows an explicit real-money
warning banner for any non-test entry, right above the buttons -- same
point-of-no-return reasoning as the "check twice" modal the "Place bets"
button already had before a job is even queued.

## Testing the Google Sheet write-back (`writeSheetOnTest`)

A test job (`test: true`) normally never writes anything to the Sheet --
there's no real Potential Return to report, and writing a fake number into
a real cell would corrupt real WIN data (see server.js's own comment on
`/betfair-place-result`). This is the ONE deliberate exception: an explicit
opt-in to prove the write mechanism itself actually works end to end
(the real Apps Script `adminSetWinValue` call, into a real DASHBOARD cell),
without ever placing a real bet.

**Only use this when Winston has explicitly asked for this exact test.**
Queue the job with `writeSheetOnTest: true` alongside `test: true`:

```
POST /betfair-place-request
{"player": "<name>", "test": true, "writeSheetOnTest": true}
```

`driver.js` picks this up automatically from the claimed job (logged as
`(writeSheetOnTest)` right after `(test mode)` in its first log line) --
nothing else changes about how you run it. When each bet is approved, its
real `sheetColIdx` (from Code.gs's own DASHBOARD headers -- D18/E18 =
Snackbar bet 1/2, F18/G18 = Timbo bet 1/2, H18/I18 = Pepe bet 1/2, J18/K18
= Sjaak bet 1/2, added 2026-10) and its
real `potentialReturn` get written for real via `adminSetWinValue`, same
as the admin panel's manual WIN entry already does.

After the run, confirm the write actually landed: check the app's Bets tab
(the WIN £ figure for that player/bet column should now show the real
potential return) or the DASHBOARD sheet cell directly, and report back
plainly whether it matches what the driver logged. Since this deliberately
writes into a real, live cell (not a sandboxed test one), only run it when
Winston has confirmed it's safe to do right now (e.g. a cell that's
currently empty/resettable, not mid-matchweek real data).
