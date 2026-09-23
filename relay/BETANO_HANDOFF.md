# Betano automation -- handoff / status (2026-09-23)

Where things stand at the end of today's session, for picking back up
tomorrow without re-deriving context. See also `betano-automation/README.md`
(has the same test-run log, kept in sync) and `BETANO_RECON.md` (the
underlying page-structure reference this was all built against).

## The big picture

Rebuilding the weekly-accumulator automation, same deterministic-Playwright-
plus-narrow-AI-fallback architecture as the retired Betfair build, retargeted
at Betano (Winston's own, ID-verified account -- no VPN, no third-party-
account-access question, unlike the Betfair attempt that got shelved over a
real compliance concern). All Betfair-specific code/docs were deleted; the
site-agnostic queue infrastructure (`betfairExport.js`, `betfairQueue.js`,
`server.js`'s `/betfair-place-request/*` routes) was kept as-is, naming just
stale.

Everything runs the same collaborative loop: OpenClaw (a separate Claude Code
session on Winston's Mac) drives the real browser via CDP and diagnoses
failures live against the actual page state; this session (on
`claude/github-connection-check-3esm0c`, merged to `main` after every fix)
owns `driver.js`/`betanoPlan.js`/the docs and applies the fixes OpenClaw's
diagnosis calls for. Winston relays messages between the two by hand.

## Test-run history so far (5 runs, all real, against the live site)

1. **`networkidle` never resolves on Betano** -- confirmed live (page was
   fully loaded and usable, but the wait never returned; Betano keeps
   continuous background traffic running). Fixed: `gotoFixturesList`/
   `gotoMatchPage` helpers using `domcontentloaded` + an explicit wait for a
   real element, replacing all four `networkidle` call sites.
2. **Hard-stop path gap** -- `main()`'s initial fixtures-list navigation ran
   before the `try` block started, so a failure there skipped the entire
   hard-stop-screenshot-and-report path, leaving the job stuck "claimed"
   with zero failure trace. Fixed: moved inside `try`, as its first
   statement.
3. **`OPENAI_API_KEY` missing** -- Stagehand's constructor validates it
   eagerly, once per bet, even on a run where the AI fallback never fires.
   Wasn't set anywhere in the driver's environment; had no bridge from
   OpenClaw's own stored credential (`auth.profiles.openai:default` in
   `openclaw.json`) to a spawned child process's env (confirmed by reading
   the installed OpenClaw package source directly -- `resolveApiKey`-style
   calls only exist in the Gateway's own model-calling code, nothing bridges
   to the exec tool's `env` field). Winston set it directly on the Mac
   himself, in his own terminal (never typed into this chat -- an earlier
   attempt to relay the raw key through chat got silently masked by a
   platform-level redaction before OpenClaw ever saw it, which was actually
   the right outcome). Now lives in a (git-ignored) `.env` in
   `betano-automation/`, loaded via `node --env-file=.env driver.js`.
   **Winston flagged that key as exposed in a chat transcript regardless
   and said he'd rotate it on OpenAI's dashboard once testing settles --
   that's still outstanding, not yet done as of this writing.**
3a. Mid-diagnosis of the next bug, the `betano` profile was found logged
    out (confirmed live: REGISTER/LOGIN visible instead of DEPOSIT). Not a
    code bug -- Winston logged back in by hand. Worth knowing for later:
    the login is saved via Google and is low-friction to restore (just
    click "Login" top right, pre-filled, then close the bonus/deposit
    popup with the X) -- flagged as a possible future self-healing-login
    step, explicitly deferred as a "someday" idea, not built now.
4. **Fixture-row scoping bug** (the real bug hiding behind the "was it just
   being logged out?" question in run 3) -- the tr/li/div-ancestor
   heuristic borrowed from Betfair was wrong on two counts on Betano: wrong
   depth (Betano's fixtures list has no `<tr>`/`<li>` at all, so the
   fixture link's immediate parent already matched the filter, one level
   short of the real row wrapper) and a wrong element-type assumption
   (Betano's price controls are `<div role="button">`, not native
   `<button>` -- didn't break the driver's own role-based locators, but
   threw off manual DOM probing during diagnosis). Confirmed precisely via
   live reproduction, including reading the real accessibility tree.
   Fixed: `buildFixtureIndex`'s row-scoping XPath now walks up from the
   fixture link until it finds an ancestor whose subtree actually contains
   a `role="button"` descendant -- depth-agnostic, not a fixed guess.
   **Confirmed working on the very next run**: zero AI fallback calls
   needed, all 6 legs added via deterministic locators cleanly.
5. **`fillStake` debounce race** -- the only failure left in that same
   run. `fillStake` read the BET NOW button's potential-winnings label once,
   immediately after `.fill()`, to verify the stake registered. Betano
   debounces that label's recompute by ~300-500ms after the input changes,
   so a run's very first stake entry (empty -> a real number) reliably
   caught the stale, pre-debounce "disabled" label -- a false failure on a
   fill that had actually worked. Confirmed via three separate live
   reproductions (still stale at +200ms, caught up by +500ms). Fixed:
   polls the label for up to 2s (every 150ms) instead of checking once.
   **Not yet re-run against the live site as of this writing** -- this is
   the next thing to verify.

## Where this leaves things

Everything found so far has been fixed and is pushed to `main`. The
row-scoping fix already got a clean confirmation (zero fallback calls, all
legs added) -- `fillStake`'s debounce fix is the one still unverified. If it
holds, the very next run should be the first one to reach a genuine
`awaiting_confirmation` state on Betano -- i.e., the first fully-built,
screenshotted, real accumulator slip ready for Winston's actual approve/
reject in the app.

## Next steps, in order

1. `git pull origin main` in `betano-automation/` (picks up the `fillStake`
   fix).
2. Confirm the `betano` browser profile is logged in (screenshot check, not
   just an immediate post-reload read -- that raced falsely at least once
   already).
3. Queue a fresh test job for Pepe (`POST /betfair-place-request` with
   `{"player":"Pepe","test":true}`, or it may already be queued -- check
   `/betfair-place-request/queue` first, since `getNext()` returns null if
   *anything* is already claimed, not just for that player).
4. Re-run via `openclaw agent --agent acca --message "..."` with
   `--env-file=.env` in the launch command, same as the last two runs.
5. If it reaches `awaiting_confirmation` cleanly: that's the milestone --
   first real end-to-end build on Betano. Approve/reject it for real in the
   app to confirm the decision-poll -> reject/approve -> report loop closes
   out correctly too (this exact path is written but has never been
   exercised against Betano yet, only against Betfair).
6. Once a full test job (both bets) completes cleanly: rotate the OpenAI key
   Winston flagged as exposed (platform.openai.com), and revisit the
   remaining UNVERIFIED items in `betano-automation/README.md` (the CDP
   port guess, "Remove selections" disambiguation, the empty-betslip string)
   as they come up on further runs -- same iterative pattern as everything
   above.

## Longer-term, not started

- A Betano equivalent of the retired `DRIVER_MANUAL.md` (the Telegram
  screenshot hand-off wrapper around `driver.js`'s `SCREENSHOT_READY`/
  `HARDSTOP_SCREENSHOT_READY` log lines) -- needs writing once this is
  live-tested end to end.
- `SOUL.md`'s dangling Path 1/Path 2 references (Betfair-era), and whether
  to keep or rename the "acca" agent identity for the Betano flow -- both
  explicitly deferred by OpenClaw as "not something to guess at unasked."
- Deciding the trigger/integration that replaces manually asking for a test
  run each time (task #3 in this session's tracked task list) -- not
  addressed yet, was already pending before today's session.
