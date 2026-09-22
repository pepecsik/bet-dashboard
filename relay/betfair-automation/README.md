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

## One-time setup (do this before the first real run)

1. `npm install` in this folder.
2. This script launches its **own independent Chrome profile** via
   Playwright -- deliberately not Anne/OpenClaw's browser session, since
   that's managed through OpenClaw's gateway and isn't something a plain
   script can attach to. That means it needs its own login, separate from
   whatever Anne already has.
3. Set `BETFAIR_PROFILE_DIR` to wherever you want that profile stored
   (defaults to `./betfair-chrome-profile` in this folder). Launch it once
   manually to seed it:
   ```
   BETFAIR_PROFILE_DIR=./betfair-chrome-profile node -e "
     import('playwright').then(async ({chromium}) => {
       const ctx = await chromium.launchPersistentContext(process.env.BETFAIR_PROFILE_DIR, { headless: false });
       console.log('Log in to Betfair in the window that opened, clear any Cloudflare check, then close it.');
     });
   "
   ```
   Log in for real, clear the Cloudflare Turnstile check if it appears (a
   normal human click -- see the project's own rule on why this script
   itself must never do that automatically), then close the window. The
   profile directory now holds a valid session + `cf_clearance` cookie,
   which is what let recon run challenge-free afterward.
4. Confirm `RELAY_URL` (env var, defaults to the deployed Render URL) is
   reachable from the Mac.

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
