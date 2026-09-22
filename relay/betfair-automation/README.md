# Betfair automation driver

Runs on the Mac (needs GB routing + a real Betfair login) -- NOT deployed to
Render, unlike the rest of `relay/`. Builds one player's weekly accumulator
on Betfair Sportsbook using `../betfairPlan.js`'s ordered plan and the page
structure documented in `../SPORTSBOOK_RECON.md`, then reports the built
slip to the relay for the existing app-based approve/reject flow. It never
clicks Place Bet itself.

## Status: first draft, not yet run against the live site

`driver.js` was written from `SPORTSBOOK_RECON.md`'s notes, without live
browser access to verify the exact selectors. Expect the first real run to
surface selector mismatches -- that's what the AI fallback (Stagehand) and
its logging are for. Treat this as a solid starting point to test and fix
against the real page, not a finished script.

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
node driver.js Pepe
```

- Exits 0 and logs the AI-fallback count on success (slip built, reported to
  the relay as `awaiting_confirmation`).
- Exits 1 and logs the error on any hard stop -- including a genuine
  Cloudflare Turnstile challenge (never auto-clicked, per the project's
  standing rule) or a same-match conflict (shouldn't happen given
  `betfairPlan.js`'s data shape, but checked for real on-page state anyway).

## Known open questions for whoever tests this first

- **Exact Stagehand wiring**: `driver.js` constructs `Stagehand` with
  `env: "LOCAL"` pointed at the same Playwright `page` this script already
  has -- verify this matches whatever Stagehand version actually installs,
  since the exact local-mode constructor options may have changed. Check
  Stagehand's own docs/CHANGELOG against `package.json`'s pinned version.
- **Selector accuracy**: every locator in `driver.js` (fixture row matching,
  price button positions, Correct Score scoreline rows, Over/Under goal
  lines) was written from `SPORTSBOOK_RECON.md`'s notes, not verified live.
  Run it against a real week's bets, watch where it needs the AI fallback,
  and tighten the deterministic locator for any step that falls back
  often -- the whole point of this design is that the fallback rate should
  trend toward zero as selectors get corrected, not stay a fixed 10%.
- **Integration/trigger**: not decided yet -- see `../STAGEHAND_PLAN.md`'s
  status section. For now this is a standalone script; something (most
  likely OpenClaw) needs to actually invoke it when a placement is due, and
  relay a hard-stop failure to Winston the same way Anne does today.
