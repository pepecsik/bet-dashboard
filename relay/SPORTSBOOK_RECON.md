# Sportsbook Reference (EPL Match Odds + Goals/Correct Score)

Permanent reference for the Sportsbook automation, gathered by OpenClaw/Anne via
a deliberate, unhurried recon pass on 2026-09-21, logged in, on the persistent
`betfair` browser profile. This is the source of truth the Stagehand-based
automation (see `STAGEHAND_PLAN.md`) reads from instead of re-discovering the
page through trial and error each run.

**Scope is deliberately narrow — this bot only ever touches three things:**

1. **English Premier League only** — no other competition, no other sport.
2. **Match Odds (1X2)** — picked directly from the EPL fixtures list, first.
3. **Over/Under Goals or Correct Score** — picked from the individual match
   page, second, after the list picks are done.

Nothing else. No Both Teams To Score, no Bet Builder market, no other
competitions. If a future task asks for anything outside this list, treat it
as out of scope and flag it rather than improvising from these notes.

---

## 1. EPL fixtures list — direct URL, Match Odds picks

**Navigate directly to:**
```
https://www.betfair.com/betting/football/english-premier-league/c-10932509
```

Do **not** reach this via Competitions tab → English Premier League click —
that UI click path is what triggered a Cloudflare Turnstile challenge in
earlier testing. Direct URL navigation to this exact page was clean every
time. Fewer clicks, more direct URLs.

Confirm you're on the "Matches" tab (default) and the market selector reads
"Match Result" (also default). Each fixture row:
```
- link "<Home> <Away> <date/time>" [ref] -> href: football/english-premier-league/<home>-v-<away>/e-<eventId>
- button "<price>" [ref]   <- Home / column "1"
- button "<price>" [ref]   <- Draw / column "X"
- button "<price>" [ref]   <- Away / column "2"
- button [ref]             <- unlabeled 4th control (stats icon, ignore)
```
- The three price buttons are named **by price only** (e.g. `"3/10"`) — there
  is no team name in the accessible name. Identify which is which **by
  position** (1st/2nd/3rd button following the fixture's `link`), matching
  the header row `1 X 2`.
- Clicking a price button adds the leg directly to the betslip with **no
  navigation** — same URL, betslip panel updates in place. This is the
  intended flow: no need to open the match page for Match Odds.
- Grab the fixture's `link` href from this same snapshot if you'll need the
  match page next — it already contains the exact match-page URL, no need to
  re-search for it.

## 2. Match page — direct URL pattern, Goals/Correct Score picks

**URL pattern** (get the exact slug from the fixtures-list link href, don't
guess it):
```
https://www.betfair.com/betting/football/english-premier-league/<home>-v-<away>/e-<eventId>
```
Example: `https://www.betfair.com/betting/football/english-premier-league/arsenal-v-leeds/e-36065339`

Tab bar on this page: **Popular / Bet Builder / Over/Under / All Markets**.
Only two destinations matter for this bot:

### Over/Under Goals → stay on **Popular** tab (default on page load)

No extra click needed beyond loading the URL. Section structure:
```
- Over / Under Goals (heading, inside a collapsible card -- expanded by default)
  - button "Regular Time" / button "First Half"   <- sub-toggle, default is Regular Time
  - paragraph "0.5 Goals" / "1.5 Goals" / "2.5 Goals" / "3.5 Goals"   <- goal-line labels, NOT buttons
  - button "<price>"   <- Over column
  - button "<price>"   <- Under column
  - button "Show More"  <- reveals additional goal lines (4.5+) without navigation
```
Price buttons here are named **by price only** (e.g. `"13/20"`), same
convention as the fixtures list — position (Over column vs Under column)
determines which is which, not the accessible name.

### Correct Score → click **All Markets** tab, then expand the accordion

`All Markets` tab click just appends `?tab=all-markets` to the URL — no
reload, no navigation risk, confirmed clean. Correct Score is a **collapsed
accordion by default** and must be expanded:
```
- button "Correct Score" [ref]   <- click this to expand (wraps a heading, same element)
  - button "1 - 0" [ref]: paragraph "1 - 0"   <- scoreline label, NOT the price control
  - button "<price>" [ref]                     <- THIS is the one to click for the leg
  - button "2 - 0" [ref]: paragraph "2 - 0"
  - button "<price>" [ref]
  ... (one label+price pair per scoreline, up to long-shot lines like "0 - 11")
```
**Important:** each scoreline row is actually two adjacent buttons — a
scoreline-labelled one and a price-labelled one. Only the **price button**
was confirmed to add a leg to the betslip. Do not click the
scoreline-labelled button; it wasn't verified to do the same thing and may
behave differently.

Match page buttons in general (Popular and All Markets alike) are named
**`"<Team/Label> <price>"`** combined (e.g. `"Arsenal 3/10"`) — a different
convention from the fixtures list's price-only buttons. Don't assume the two
pages share a naming pattern.

---

## Critical gotcha: same-match legs trigger Bet Builder, not a normal accumulator

**This must be detected and handled explicitly — it will not announce itself
as an error.**

Betfair's betslip silently changes behavior depending on whether the legs in
it share a match:

- **Legs from two different matches** (the normal case for this bot — one EPL
  match's Match Odds pick plus a *different* EPL match's goals/correct-score
  pick) combine automatically into a **"Multiples"** betslip tab, forming a
  standard accumulator (e.g. a Double) with combined odds shown. This is the
  expected, working path.
- **Two legs from the *same* match** (e.g. that match's Match Odds pick AND
  its own Over/Under or Correct Score pick both in the slip at once) cause
  the betslip to switch into a **"Bet Builder"** tab instead — a
  same-game-parlay mode, not a normal multi. Confirmed behavior seen: a Match
  Odds + Correct Score pairing on one match produced a **"Some selections
  cannot be combined"** warning and refused to price up ("Your Bet Builder
  needs one more selection"), while a Match Odds + Match Odds 90 pairing on
  one match *did* combine into a same-match Double. So same-match
  combinability is market-pair-dependent and not reliable — don't assume it
  will work.

**Practical rule for this bot:** since the plan is "Match Odds first from the
list, then Goals/Correct Score second from match pages," make sure the
goals/correct-score leg is always taken from a **different fixture** than any
Match Odds leg already in the slip for that same accumulator, unless the task
explicitly wants a same-match combo. Before finalizing, check the betslip
tab: it should read **"Multiples"**, not **"Bet Builder"** — if it's showing
"Bet Builder" or a "Some selections cannot be combined" warning, two legs
landed on the same match and need to be split apart (e.g. into separate bets)
rather than proceeding as if it were a normal accumulator.

---

## Cloudflare / Turnstile notes

- Direct URL navigation (fixtures list, match pages, `?tab=all-markets`) was
  clean every time in this pass — no challenges.
- The one confirmed Turnstile trigger in prior testing was a **UI tab click**
  (Competitions tab), not a direct URL load — reinforcing the "direct URL
  over UI navigation" rule above.
- The persistent `betfair` browser profile retains the `cf_clearance` cookie
  (domain `.betfair.com`) once solved — this is what prevents repeat
  challenges across a session, not pacing alone. Still worth spacing actions
  out; don't fire requests back-to-back.
- If Turnstile appears anyway: stop, screenshot, notify Winston, do not
  attempt to solve or click through it (per `TOOLS.md`).
