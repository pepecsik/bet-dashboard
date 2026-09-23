# Sportsbook Reference — Betano (EPL Match Result + Goals/Correct Score)

Permanent reference for the Betano automation. **Scope is deliberately narrow — this bot only ever touches three things:**

1. **English Premier League only** — no other competition, no other sport.
2. **Match Result (1X2)** — picked directly from the EPL fixtures list, first.
3. **Over/Under Goals or Correct Score** — picked from the individual match page, second, after the list picks are done.

Nothing else. No Both Teams To Score, no Double Chance, no other competitions. If a future task asks for anything outside this list, treat it as out of scope and flag it rather than improvising from these notes.

This file is the source of truth for page structure and URLs — read it directly rather than re-discovering the page through trial and error. Findings below came from a deliberate, unhurried recon pass on 2026-09-23, logged in (ID-verified, Winston's own account), on a clean `betano` browser profile with no VPN.

**Do not assume anything here mirrors Betfair's structure (`SPORTSBOOK_RECON.md`, since retired) — Betano is a genuinely different site with different mechanics in several important places.** The differences are called out explicitly below.

---

## 1. EPL fixtures list — direct URL, Match Result picks

**Navigate directly to:**
```
https://www.betano.pt/en/sport/soccer/england/premier-league/1/
```
Confirmed clean both via UI click-through (Soccer sidebar link → England → Premier League link) and via direct URL load — no challenge/redirect either way. Default landing tab is "Popular", which shows the fixtures list with Match Result odds already visible — no extra tab click needed.

Each fixture row (from the accessibility snapshot):
```
- link "<Home> <Away>" [ref]          -> href: /en/match-odds/<home>-<away>/<eventId>/
- button "Bet on 1 with odds <price>." [ref]
- button "Bet on X with odds <price>." [ref]
- button "Bet on 2 with odds <price>." [ref]
```
- Price buttons **do** carry a full accessible name here (`"Bet on 1 with odds 1.39."`) — unlike Betfair, where fixtures-list buttons are named by price only. You can click by accessible name directly; no need to identify by position.
- Clicking a price button adds the leg to the betslip with **no navigation** — same URL, betslip updates in place. Same intended flow as Betfair: no need to open the match page for Match Result.
- Grab the fixture's `link` href from this same snapshot for the match-page URL — already contains the exact slug and event ID, no need to re-search.

## 2. Match page — direct URL pattern, all other markets

**URL pattern** (get the exact slug + eventId from the fixtures-list link href):
```
https://www.betano.pt/en/match-odds/<home>-<away>/<eventId>/
```
Example: `https://www.betano.pt/en/match-odds/arsenal-fc-leeds-united/92398226/`

**Important gotcha — slug normalization:** Betano silently 30x-redirects some slugs (confirmed: `arsenal-fc-leeds-united` → `arsenal-leeds-united`, dropping `-fc`). Don't hard-fail if the URL you land on differs slightly from the one you navigated to — compare event IDs, not slugs, to confirm you're on the right match.

**No tabs, unlike Betfair.** Every market for this fixture lives on one page, stacked vertically in a fixed order — no "Popular / All Markets" tab click needed at all:

1. Match Result (1X2) — expanded by default
2. "Win the match or lead by 2 goals" — expanded by default (a 2-way team-vs-team market, not Draw No Bet — don't confuse the two)
3. Over/Under Total Goals — expanded by default, shows 1.5/2.5/3.5 lines directly, **"SHOW ALL" button** reveals more lines (4.5+, matching Betfair's pattern)
4. Double Chance — expanded by default (out of scope, don't touch)
5. Both Teams to Score — expanded by default (out of scope, don't touch)
6. First-Half Result — **collapsed accordion** (out of scope)
7. Over/Under First Half Goals — **collapsed accordion** (out of scope)
8. `<Team> - Over/Under Total Goals` (per team) — **collapsed accordion** (out of scope)
9. Both Teams to Score or Over 2.5 — **collapsed accordion** (out of scope)
10. Draw No Bet — **collapsed accordion** (out of scope)
11. Handicap Match Result — **collapsed accordion** (out of scope)
12. Halftime/Full Time — **collapsed accordion** (out of scope)
13. **Correct Score — collapsed accordion, must be expanded** (in scope)

### Over/Under Goals → no click needed, already expanded on page load
```
- button "Bet on Over <line> with odds <price>." [ref]
- button "Bet on Under <line> with odds <price>." [ref]
- button "SHOW ALL" [ref]   <- reveals additional lines (4.5+) without navigation
```
Named by full description (`"Bet on Over 2.5 with odds 1.7."`), same convention as the fixtures list. This is a **different naming convention from Betfair**, where match-page buttons are named `"<Label> <price>"` combined rather than as a full sentence — don't assume the two sites share a naming pattern.

### Correct Score → collapsed by default, must be expanded first
The heading is a `<div>` deep in the DOM, not a native `<button>` — but its actual clickable wrapper (a `role="button"` element) is what needs the click, and its price cells are `role="button"` divs too (not native `<button>` tags), which matters for how you locate them (see gotcha below). Once expanded:
```
- button "Bet on <score> with odds <price>." [ref]   (e.g. "Bet on 1 - 0 with odds 5.9.")
- ... one button per scoreline, laid out 3-per-row ...
- button "SHOW ALL" [ref]   <- reveals more scorelines
```
Price buttons here **do** carry full accessible names (`"Bet on 1 - 0 with odds 5.9."`) — this is actually cleaner than Betfair, where Correct Score buttons were price-only and needed position-based disambiguation from an adjacent non-functional scoreline-label button. On Betano there's no decoy element — the button you find by name is the one to click, full stop.

**Gotcha — the Correct Score section (and everything below Both Teams to Score) can silently fall outside a snapshot's node limit.** A full-page `--interactive --compact` snapshot with the default/moderate `--limit` will end at "Both Teams to Score" and jump straight to the footer, silently omitting the six collapsed accordions and Correct Score entirely — it looks like those markets aren't rendered at all, but they are, just deep enough in the DOM to get cut off. Fix: either pass a much higher `--limit` (600+ was still sometimes not enough after expanding; scope it instead), or scope the snapshot to the specific market card via `--selector` once you've located it (e.g. `.markets > div:nth-child(14)` worked during recon, but that index is fragile — better to locate the card by walking up from a text match on "Correct Score" and tagging it, the way this recon pass did, if selector-based scoping is needed in the automation itself).

## 3. Betslip — floating widget, not a static sidebar column

**This is structurally different from Betfair**, where the betslip is a fixed column always visible in the page layout. On Betano, the betslip is a **fixed-position floating widget** (`.bet-slip-container`) that overlays near the bottom-right of the viewport once a selection exists. It is not part of the normal page flow, so:
- It won't show up in an ordinary full-page screenshot in a useful way (full-page screenshots don't composite `position: fixed` elements correctly — see gotcha below). Use a scoped element check (`browser evaluate` on `.bet-slip-container`, or `browser snapshot --selector '.bet-slip-container'`) to inspect it reliably, not a screenshot.
- Selections **persist across a page reload** (confirmed: reloading mid-recon kept every leg in the slip). This is a useful safety property but also means a stale/leftover selection from a previous run could carry into a new one — worth a clean-slip check at the start of a job, same spirit as Betfair's "don't accumulate tabs" discipline.

Structure once at least one selection exists:
```
- button "<count> <combined-odds-or-single-price>" [ref]   <- floating toggle/badge
- heading "Betslip"
- button "Remove selections" [ref]      <- clears entire slip
- radiogroup "Betslip": radio "Single" / radio "Multiple" / radio "System"
- (repeated per leg:)
  - link "<Team>" -> match-page URL
  - text "<price>"
  - button "Remove selections" [ref]    <- removes just this leg
  - link "<Market name>" -> match-page URL
  - link "<Home> <Away>" -> match-page URL
- (stake area — shape depends on bet-type mode, see below)
- button "BET NOW" [ref]   <- disabled until at least one leg has a stake > 0
```

### Bet-type mode is chosen automatically based on what's in the slip
- **1 leg:** `Single` forced/checked. One stake box, quick buttons `+2 / +10 / +50 / MAX`, and a live `"<profit> € Profit"` line under it.
- **2+ legs, all from different matches:** `Multiple` auto-checked. All legs collapse under **one shared stake box** labeled `"<Combo name> = <count> <combined odds>"` (e.g. `"Double = 1 3.68 €"` for 2 legs, "Doubles"/"Trebles" etc. scale with leg count). `BET NOW` itself displays the live total once staked: `"BET NOW 2.000,00 € Potential winnings 7.360,00 €"` — note EU number formatting (`.` thousands, `,` decimal).
- **2 legs from the *same* match (a genuine conflict, e.g. that match's Match Result + its own Correct Score):** `Single` is forced, `Multiple`/`System` aren't viable — **each leg gets its own independent stake box**, exactly like the 1-leg case, just twice. No combined odds anywhere. No error message shown either — it just quietly won't offer a combined option.
- **3+ legs where some (but not all) pairs conflict:** `System` auto-checked, with an explicit **`"These bets cannot be combined"`** notice, and the slip auto-computes every combination that IS valid, grouped and separately stakeable — e.g. with legs A (Arsenal Match Result), B (Ipswich Match Result), C (Arsenal Correct Score — same match as A): the slip showed `"Singles = 3"` and `"Doubles = 2"` (the valid double being A+B and B+C; A+C is excluded since A and C share a match, and no treble is offered since a treble would necessarily include the invalid A+C pair). This is Betano computing valid sub-combinations automatically, not an all-or-nothing block.

## 4. Critical difference from Betfair: same-match conflicts don't trigger a mode-switch, they trigger recombination

**Betfair's behavior:** same-match legs silently switch the whole betslip into a "Bet Builder" (same-game-parlay) tab, which can flat-out refuse to price up certain market pairings ("Some selections cannot be combined").

**Betano's behavior is different and, so far, more forgiving:** there is no separate same-game-parlay mode at all. Instead:
- With **exactly 2 legs** that share a match, Betano just forces `Single` mode — both legs are still fully bettable, just as two independent single bets rather than a combo. Nothing is blocked.
- With **3+ legs** where a same-match pair exists among otherwise-combinable legs, Betano switches to `System` and auto-generates every valid combination that excludes the conflicting pair, showing `"These bets cannot be combined"` as a plain informational note (not a hard error) alongside whatever it can still combine.

**Practical rule for this bot, unchanged in spirit from Betfair:** since the plan is "Match Result first from the list, then Goals/Correct Score second from match pages," keep the goals/correct-score leg on a **different fixture** than any Match Result leg already in the slip for the same accumulator, unless a same-match combo is explicitly wanted. Before finalizing, check which radio is checked (`Multiple` = clean combo as intended; `Single` or `System` = a same-match conflict happened and the bet isn't shaped the way it was meant to be) rather than assuming success.

## 5. Stake & payout display

- Each stake box is a `textbox`, editable directly, with quick-add buttons (`+2`, `+10`, `+50`, `MAX`) next to it. `MAX` filled in `2000` during recon (likely an account/market cap, not literally "all funds") — don't assume `MAX` means the account balance.
- **Single/System mode:** potential return is shown per-leg as a live `"<profit> € Profit"` line directly under that leg's stake box (profit only, not total return — e.g. a €10 stake at odds 1.39 showed `"3,90 € Profit"`, i.e. `10 × 1.39 − 10`).
- **Multiple mode:** no per-leg profit line — the combined potential return is shown only once stake is entered, embedded directly in the `BET NOW` button's own label (`"BET NOW <stake> € Potential winnings <total> €"`). There is no separate summary line elsewhere on the page — the button text *is* the confirmation summary. Read it from there.
- All monetary figures use **EU formatting**: `.` as thousands separator, `,` as decimal separator (e.g. `2.000,00 €`). Don't parse these as US-formatted numbers.

## 6. Multiples/accumulators are genuinely live — confirmed directly, not just claimed

Directly tested during this recon pass (not just inferred): adding two Match Result legs from different matches auto-combined into a `Multiple` (`Double`) with correctly computed combined odds (1.39 × 2.65 = 3.68, matched exactly), a live stake box, and a real potential-winnings figure on `BET NOW`. This is a real, working feature on the live site today, not a beta flag or a promise — no separate confirmation step or "opt in" was needed. The account also has live promotional tooling built around multiples specifically (a "Bet Mentor" suggestion widget, and a "FULL BET" reward that explicitly unlocks with a 3rd selection), which wouldn't exist if multiples were shaky or newly-rolled-out. Corroborated externally too — SRIJ-licensed Portuguese operators, Betano included, actively promote combined/accumulator betting as a standard feature (Combo Boost, enhanced multiples odds).

Sources:
- [Múltiplas Betano » Guia Completo em 2026](https://oddsscanner.com/pt/apostas/betano/multiplas)
- [Betano (company) – Wikipedia](https://en.wikipedia.org/wiki/Betano_(company))

## 7. Browser zoom

The `betano` profile is persistently set to **67% browser zoom** (Winston's own setting, set by hand via Chrome's UI — not scriptable through the automation, see gotcha below — to fit a full multi-leg accumulator's worth of selections into a single confirmation screenshot). Confirmed by direct comparison at the real window size (1036×1009): at 100% zoom the left nav collapses to an icon-only rail once several markets/legs are on screen; at 67% the full labeled sidebar and considerably more of the page fit without collapsing or needing to scroll. Same spirit as Betfair's persistent 75% zoom, just a different value tuned for this site's layout — don't assume the two percentages are interchangeable if this ever gets re-tuned.

**Gotcha — zoom cannot be set from the automation.** Chrome's native zoom (Cmd+- / Cmd+= / Cmd+0, or the ⋮ menu) is a browser-chrome-level shortcut, not a page-level one — synthetic key events dispatched via CDP (`browser press`) land on the page's content and do nothing to real browser zoom, even though the command reports success with no error. If zoom ever needs to change, ask Winston to set it by hand in the actual window, the same way this 67% was set — don't waste time trying to script it.

## 8. Browser / viewport gotchas (environment-specific, not Betano behavior)

- **Never call `browser resize` on this profile once Betano is loaded, if a human is watching the real window.** `resize` only changes the CDP-emulated viewport (`window.innerWidth`/`innerHeight`) — it does **not** move the actual OS Chrome window (`window.outerWidth`/`outerHeight` never change). Worse, it applies its own internal device-pixel-ratio scaling (confirmed 4:3 — passing `1600×1000` produced an emulated `2133×1333`), so naively passing the real window's pixel size still produces a mismatch. If a resize is genuinely needed, compute `arg = realOuterDimension × 3/4` first, or better, just avoid resizing this profile at all mid-session.
- **A viewport/emulation mismatch causes two distinct symptoms, both seen during this pass:** (a) the floating betslip widget (`.bet-slip-container`) renders at a stale/incorrect `left` position — sometimes far enough negative to be entirely off-screen and unclickable — and (b) page content visibly overflows the real window because it's laid out for a wider viewport than what's actually being displayed. **The fix for both is the same: reload the page** once the viewport is correct — Betano recalculates layout cleanly on a fresh load, it just doesn't react correctly to a live resize event.
- The floating betslip is genuinely `position: fixed`, so scrolling the page doesn't move it and `scrollIntoView` on an element inside it has no visible effect — don't use scroll position to try to bring it into view; if it's not visible, it's a positioning bug (see above), not a scroll problem.

---

## Cloudflare / bot-check notes

No Cloudflare Turnstile or other CAPTCHA challenge was encountered anywhere in this pass (fixtures list, match pages, direct URL loads, and UI click-throughs alike). If one appears in a real run anyway: stop, screenshot, notify Winston, do not attempt to solve or click through it — same hard-stop rule as the retired Betfair workflow.
