# CLAUDE.md

Notes for future Claude sessions working on this repo.

## Repeating goal-flash animation bug (investigated + fixed 2026-11-10)

**Symptom reported by user:** during a live match, the match row and the
scorer's bet cells would pulse (the gold `goalFlash` animation on
`.flash-active`) correctly on a real goal -- but then kept repeating the
same pulse every ~20-30 seconds afterward, with no new goal, seemingly
forever, for as long as the match stayed live.

**How it was finally diagnosed** (useful pattern if something like this
comes back): browser-console reproduction beats sandboxed Playwright
repro here, because the real bug only showed up against the live relay +
real Apps Script deployment. The decisive steps, in order:
1. Had the user add a fake test match directly into the Google Sheet
   (bypassing API-Football/relay entirely) with a fixed score/status that
   never changes, to prove the bug exists even with zero real data
   churn. Picked a match name that can't collide with any real team
   (`ZZZ - ZZZ` -- an earlier attempt using `ARS - ARS` accidentally
   collided with a real "Newcastle - Arsenal" fixture because the
   diagnostic's `.find()` grabbed the wrong one).
2. Console snippet wrapping `window.fetch` to log the raw `{match,
   status, score, kickoffTs}` payload on every poll -- proved the server
   data was 100% constant, byte-for-byte, across every poll (both the
   relay/WS path and the `?mode=fast`/plain Apps Script endpoints).
3. Console snippet watching `window.__liveMatchState[matchName]` on an
   interval -- proved the client-side cache that scoreChanged/hasChanged
   compare against was *also* perfectly constant the whole time.
4. `document.addEventListener('animationstart', ..., true)` filtered to
   `animationName === 'goalFlash'` -- proved the CSS animation really was
   restarting every ~28-30s (not just a `class` attribute artifact --
   `classList.add/remove` always re-serializes the `class` attribute even
   on a no-op, so MutationObserver-based class-watching produces false
   positives; animationstart is the real ground truth).
5. Hooked `DOMTokenList.prototype.add` AND the `Element.prototype.className`
   /`innerHTML` setters, filtered for `'flash-active'` -- **nothing fired**,
   even while the animation visibly replayed. This was the key clue: if no
   JS ever added the class at the moment of the pulse, the class must
   already have been sitting there, and something else was restarting the
   animation.

**Root cause:** `renderDashboard()` wipes `left`/`right` via
`innerHTML = ""` on every full render (every ~30s), then re-appends any
row it's reusing (the `canReuse`/`prevLeftRowByMatch` row-reuse path, which
exists specifically so a live match's row *isn't* torn down and rebuilt
every cycle). But disconnecting and reconnecting a DOM element to the
document restarts any CSS animation tied to a class already present on
it -- even if that class was only ever added once, long ago, and never
touched again. `.flash-active` (`animation: goalFlash 1.3s ...`) was never
stripped after it finished playing, in any of the 4 places that add it:
- `patchFastScores()`: the score-pill flash (~line 3765)
- `patchFastScores()`: the bet-cell flash (~line 3796)
- `renderDashboard()`'s rebuild path: score-pill, baked into an `innerHTML`
  template string (~line 4453)
- `renderDashboard()`'s rebuild path: bet cell `className` template string
  (~line 4462)

So once a real goal fired legitimately, the class stuck around forever,
and the row quietly replayed the pulse on every single subsequent render
cycle that disconnected/reconnected it -- which is every cycle, live match
or not.

This is the *exact same* bug, by the same mechanism, as an earlier
"entrance wave keeps replaying" bug that was already found and fixed for
`.animate-enter` (see the comment above `addEnterAnimation()`, ~line 4086)
-- that fix was never generalized to `.flash-active`.

**Fix applied:** a shared `clearFlashAfter(el)` helper (defined right after
`addEnterAnimation()`, ~line 4106) that does
`setTimeout(() => el.classList.remove('flash-active'), 1450)` -- same
pattern as `addEnterAnimation()`'s own cleanup, just for `flash-active`
instead of `animate-enter`. Called at all 4 sites above, right after the
class is added. Committed as "Fix repeating goal-flash animation on every
reconnect" and merged to `main`.

**Status:** fixed and shipped, but only lightly tested (one isolated fake
match, static score, over a few minutes). The user is going to confirm
properly during the next real match week and will report back if it's
still not fully resolved.

**If it comes back:** check first whether `.sweat-active` / `.sweat-clinch`
/ `.gold-active` have the same bug (they're currently *meant* to be
continuous/infinite while a condition holds, via `goldPulse ... infinite`,
so reconnect-restart shouldn't be visually different for those -- but
worth double-checking if a NEW complaint shows up about those specifically
pulsing oddly). Also worth checking: is `clearFlashAfter`'s 1450ms timer
itself vulnerable to the same disconnect bug -- i.e. if a row gets
reused/reconnected again *during* that 1.45s window, does anything reset
or duplicate the pending removal? Wasn't hit in testing but not proven
impossible either.

Three *other* real (but ultimately insufficient on their own) fixes were
shipped earlier in the same investigation, before the actual root cause
above was found. They're real fixes and should stay, but none of them
explain this symptom:
1. Relay (`relay/server.js`): `goalCandidates` map restructured to gate
   `lastKnown`/the WebSocket broadcast together with the Telegram-only
   debounce it originally guarded (extended an existing "confirm the same
   new score twice before trusting it" check to the broadcast path, not
   just Telegram).
2. Relay (`relay/server.js`): added a `pollInFlight` re-entrancy guard
   around `pollOnce()` so overlapping polls can never run concurrently.
3. `index.html`: `patchFastScores()` changed from matching DOM rows to the
   incoming `matches` array by array index to matching by `data-match` key
   (`leftRowByMatch`/`rightRowByMatch`), since the two orders aren't
   guaranteed to stay identical, especially for a match with no real
   `kickoffTs` to anchor a stable sort position (confirmed via a
   git-stash A/B test that the old positional code really could patch the
   wrong match's row).
