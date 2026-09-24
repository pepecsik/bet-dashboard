# Betano automation driver

Runs on the Mac -- NOT deployed to Render, unlike the rest of `relay/`. Builds
**both** of a player's weekly accumulators (Bet 1, then Bet 2) on Betano
using `../betanoPlan.js`'s ordered plan and the page structure documented in
`../BETANO_RECON.md`, then reports each built slip to the relay and waits
for Winston's approve/reject in the app before continuing -- same lifecycle
as the retired Betfair driver, just pointed at a different site with
different mechanics.

This is Winston's own, ID-verified Betano account -- no VPN, no
third-party-account-access question, unlike the retired Betfair attempt.

## Status: first draft, not yet run against the live site

Applies everything learned from the Betfair build (deterministic URL
navigation, real click/clear verification via the betslip's actual state,
correct Stagehand tab-binding from the start, per-bet Stagehand rebuild,
never trusting a clean exit as proof) as a starting point, rather than
rediscovering each of those from scratch. But several selectors below are
marked **UNVERIFIED** in the code's own comments -- things `BETANO_RECON.md`
didn't fully pin down and need confirming on the first real run:

- The exact CDP port for the `betano` browser profile (`BETANO_CDP_URL`,
  defaults to `8093` -- a guess based on the port mentioned during recon,
  not independently confirmed).
- ~~The fixture row's DOM wrapper~~ -- **fixed, confirmed live (2026-09-23)**.
  The tr/li/div-ancestor heuristic borrowed from Betfair was wrong on two
  counts on Betano: it stopped one level too shallow (no `<tr>`/`<li>` at
  all on this site's fixtures list), and it implicitly assumed native
  `<button>` tags when Betano's price controls are `<div role="button">`.
  `buildFixtureIndex` now walks up from the fixture link until it finds an
  ancestor whose subtree actually contains a `role="button"` descendant,
  depth-agnostic rather than a fixed tag/depth guess.
- The "Remove selections" button's top-level-vs-per-leg disambiguation
  (`clearBetslip`) -- both share the same accessible name, using `.first()`
  as a best guess.
- The exact confirmed "empty" state text for the betslip (Betfair had a
  literal "betslip is empty" string to check against; Betano's equivalent
  wasn't captured during recon) -- `clearBetslip` can only warn, not hard-fail,
  on this until a real empty-state string is confirmed live.
- The stake textbox's exact selector in Multiple mode (`fillStake`) --
  scoped to "the only textbox in the betslip container," not a specific
  confirmed `aria-label` the way Betfair's was. The selector itself has
  held up on live runs (the fill always registered); what needed fixing
  was the verification step below.

## Fixed, confirmed live (2026-09-23)

- **Stake-fill verification race.** `fillStake` used to read the BET NOW
  button's label once, immediately after `.fill()`. Betano debounces that
  label's recompute by roughly 300-500ms after the input changes, so a
  run's very first stake entry (empty -> a real number) reliably caught
  the stale, pre-debounce "disabled" label -- a false failure on a fill
  that had actually worked. Confirmed via three separate live
  reproductions (label still stale at +200ms, caught up by +500ms).
  `fillStake` now polls the label for up to 2s instead of checking once.
- **Marketing bonus popup blocking every fresh tab.** Betano shows a
  dismissible "Available bonus" popup (an iframe modal pointing at
  `/en/myaccount/marketingbonus`) on every brand-new browser tab.
  `driver.js` opens one via `context.newPage()` every run and never
  dismissed it. The modal physically intercepts pointer events
  (`esc-close:false`, `bg-close:false` -- can't be dismissed via Escape or
  a background click) and turned out to be the real root cause behind
  the run-5 `fillStake` failure, not the debounce race alone -- confirmed
  by reproducing the identical 6-leg build + stake fill sequence twice on
  a genuinely fresh tab: hard-timed-out at 30s with the modal up, worked
  cleanly (debounce settled ~1000ms, well within the 2s poll window) once
  dismissed first. New `dismissMarketingPopup(page)` called once, right
  after the initial fixtures-list navigation, before building any bets.

Expect further runs to surface more of the remaining unverified items
above -- that's what the AI fallback + this file's own logging are for,
same as before.

## Test-run log

1. **Run 1** -- `networkidle` navigation timeout + hard-stop path gap
   (main()'s initial nav ran before the try block). Both fixed.
2. **Run 2** -- Stagehand's constructor validated `OPENAI_API_KEY` eagerly
   and it wasn't set anywhere in the driver's environment. Fixed by
   setting it in a (git-ignored) `.env` and launching with
   `node --env-file=.env driver.js`.
3. **Run 3** -- widespread `locator.click` timeouts on fixture price
   buttons, initially suspected to be the row-scoping bug below but first
   traced to the `betano` browser profile being logged out (confirmed live
   via the real page showing REGISTER/LOGIN instead of DEPOSIT). Not a
   code bug -- Winston logged back in by hand.
4. **Run 4** -- same click-timeout pattern reproduced with a confirmed,
   freshly-verified logged-in session, ruling out login as the cause and
   confirming a real bug: the row-scoping heuristic (see "Fixed" above).
   Fixed and pushed.
5. **Run 5** -- row-scoping fix confirmed working (zero AI fallback calls
   needed, all 6 legs added deterministically). New, isolated failure in
   `fillStake` -- initially diagnosed as a debounce race and fixed.
6. **Run 6 (pending as of this writing)** -- `fillStake`'s debounce fix
   deployed, but the login didn't persist overnight (browser was actually
   logged out this time, not a race -- Winston logged back in by hand
   again, and confirmed the saved-Google-login popup is low-friction
   enough that OpenClaw was able to click through it directly, no manual
   credential entry needed). On the actual test run, `fillStake` still
   timed out -- but this time traced to the real root cause: the
   marketing bonus popup (see "Fixed, confirmed live" above), which was
   still open and physically blocking clicks the whole time. Debounce fix
   was correct all along; it just never got a fair test until the popup
   was also dismissed. Fixed and pushed, not yet re-run against the live
   site.

## Setup

1. `npm install` in this folder.
2. Winston logs into his own Betano account on the `betano` browser
   profile (already done as of this writing -- ID-verified, saved login,
   67% zoom set by hand). Before running `driver.js`, that browser must
   already be running with its CDP port open.
3. Set `BETANO_CDP_URL` if it's not the default (`http://127.0.0.1:8093`)
   -- confirm the actual port with whoever started the profile.
4. Confirm `RELAY_URL` (env var, defaults to the deployed Render URL) is
   reachable from the Mac.
5. Set `OPENAI_API_KEY` in the environment `driver.js` runs in -- Stagehand
   validates this eagerly at construction time (once per bet, even on a
   run where the AI fallback path never actually fires), so a missing key
   hard-stops the whole job before a single leg is attempted. Confirmed
   live (2026-09-23): the same key used for the retired Betfair build's
   fallback (also GPT-5 mini via Stagehand) works here too -- it just
   needs to be present in this folder's environment specifically, since
   `betano-automation/` is a separate directory from the old
   `betfair-automation/` one it may have been scoped to.

**Never resize this profile's viewport once Betano is loaded, if a human is
watching the real window** -- per `BETANO_RECON.md`'s own gotcha, this
breaks the floating betslip's positioning and page layout, fixed only by a
full reload. `driver.js` doesn't call resize anywhere; keep it that way.

## Running it

```
node driver.js
```

No player argument -- claims whichever job `/betfair-place-request/next`
hands back, same one-at-a-time serialization as always. Needs a real
pending request in the relay's queue first (the app's "place bet" button,
or `POST /betfair-place-request` manually, `test: true` for any test run).

For each of the (up to 2) bets in the claimed job, in order:
1. Clears whatever's in the betslip first (best-effort -- see the
   UNVERIFIED note on `clearBetslip` above).
2. Builds the slip, screenshots just the betslip element (not a full-page
   screenshot -- the betslip is `position: fixed` and won't composite into
   one correctly), logs `SCREENSHOT_READY: <path>`, and posts it to the
   relay as `awaiting_confirmation`.
3. Polls `/betfair-place-request/decision` until Winston approves or
   rejects, no timeout, heartbeat logged every 5 minutes.
4. On reject: clears the job, stops -- does not build further bets for
   that job.
5. On approve, test mode: logs "simulating," does not click anything, moves
   to the next bet (or reports fully placed if that was the last one).
6. On approve, real mode: hard-stops on purpose --
   `RealPlacementNotImplementedError`. Clicking the real BET NOW button is
   not implemented in this file at all, stays that way pending deliberate
   review, same standing rule as the retired Betfair driver.

`driver.js` has no Telegram/messaging capability of its own -- the
`SCREENSHOT_READY: <path>` log line is the hand-off contract for whatever
wraps this script (see the retired `DRIVER_MANUAL.md` for the pattern; a
Betano equivalent needs writing once this is live-tested).

- Exits 0 and logs "No pending job" if the queue is empty.
- Exits 0 on a fully successful job (every bet approved and reported).
- Exits 1 and logs the error, the page URL, and a full-page hard-stop
  screenshot (`HARDSTOP_SCREENSHOT_READY: <path>`) on any failure --
  captured before the page closes, so the real failing state is always
  directly inspectable rather than requiring after-the-fact reasoning
  about an already-closed tab.
