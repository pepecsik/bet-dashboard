---
version: alpha
name: Juice Bets
description: Dark Premier League-themed weekly betting pool dashboard. Deep purple/magenta base, lime-green for wins and correct picks, gold reserved for Hall of Fame / winner highlights.
colors:
  bgGradientStart: "#3d1350"
  bgGradientMid: "#24082e"
  bgGradientEnd: "#12040d"
  card: "rgba(45, 10, 58, 0.72)"
  soft: "rgba(255, 255, 255, 0.06)"
  row: "rgba(255, 255, 255, 0.03)"
  modal: "rgba(20, 4, 26, 0.97)"
  modalOverlay: "rgba(10, 2, 14, 0.9)"
  textMain: "#ffffff"
  textMuted: "#b79ecf"
  magenta: "#ff2882"
  gold: "#f6c90e"
  lime: "#00ff85"
  borderMagenta: "rgba(255, 40, 130, 0.3)"
typography:
  base:
    fontFamily: Inter
    fontSize: 12px
rounded:
  sm: 6px
  md: 10px
  lg: 16px
components:
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
    padding: 12px
  modal:
    backgroundColor: "{colors.modal}"
    rounded: "{rounded.lg}"
---

## Overview

Juice Bets' active theme (the app calls it `premierleague`, applied via
`[data-theme="premierleague"]` on `index.html`) is a dark, saturated purple
world lit up by one sharp accent: PL magenta. Lime-green marks something
that's currently correct or has won; gold is reserved specifically for
Hall of Fame / biggest-win highlights, not used as a general accent. The
tone is energetic and a little loud on purpose -- this is a group chat
betting pool, not a financial dashboard.

`index.html` actually ships four complete themes behind a `[data-theme]`
switch (a plain dark theme, a pink "valentine" theme, a green terminal/retro
theme, and `premierleague`) -- this file documents `premierleague` only,
since every screenshot and every live decision this project has made has
used that one. The other three exist in the CSS but aren't the active
identity; treat them as legacy/unused unless told otherwise.

## Colors

- `bgGradientStart/Mid/End` -- the page background, applied as
  `radial-gradient(ellipse at 30% 0%, {start} 0%, {mid} 40%, {end} 100%)`.
  Token type can't hold a full gradient value, so the three stops are
  listed separately; reconstruct the gradient function at point of use.
- `card` -- the base surface for cards/panels, semi-transparent over the
  page gradient (not a flat color -- it's meant to let the gradient show
  through faintly).
- `soft` / `row` -- subtler fills for nested surfaces and table rows, in
  that order of visibility (`soft` more visible than `row`).
- `modal` / `modalOverlay` -- modal sheet background and its backdrop dim.
- `textMain` -- primary text, pure white.
- `textMuted` -- secondary/label text, a muted lavender, not grey. This is
  a deliberate, recognizable part of the identity -- don't substitute a
  generic grey here.
- `magenta` -- the ONE interactive/brand accent. Used for borders, active
  states, CTAs, primary headings' accent color. In the live CSS this is
  actually stored under the variable name `--accent-orange` (left over
  from the other three themes, where that slot genuinely held an orange) --
  the value itself has nothing to do with orange. Worth knowing if you go
  looking for it in the CSS and the name doesn't match what you see.
- `gold` -- reserved. Hall of Fame entries, biggest-win/winner badges only.
  Never used as a general secondary accent.
- `lime` -- correctness/success signal: a winning pick, a live "on track"
  pulse, a positive outcome. Functions as this app's semantic "green,"
  distinct from `magenta`.
- `borderMagenta` -- the standard card/border stroke, magenta at low
  opacity, not a flat border color.

## Typography

Base font is Inter (falls back to system-ui/sans-serif), 12px root size in
the active theme. No distinct heading/body typography scale is defined as
reusable tokens in the CSS today -- individual headings set their own
size/weight inline rather than drawing from a shared type scale. Worth
having if this file ever gets actively maintained going forward, but not
invented here since it isn't real yet.

## Layout

`rounded.lg` (16px) is the standard corner radius for cards and modals;
`rounded.md`/`rounded.sm` step down for smaller elements. Beyond that,
the CSS defines several single-purpose layout constants (row height 50px,
header height 58px, an 8px base gap, fixed column widths for the bet grid)
that are specific to the matchday grid's own layout rather than a general
reusable spacing scale -- they're dimensions of one particular component,
not tokens meant to be reused elsewhere, so they're intentionally left out
of the `spacing` scale above rather than forced into it.

## Components

- `card` -- the standard panel: `card` background, `rounded.lg` corners,
  `borderMagenta` stroke, a heavy drop shadow (`0 8px 32px rgba(0,0,0,0.8),
  0 0 0 1px rgba(255,40,130,0.08)`).
- `modal` -- same shape language as `card`, darker/more opaque background,
  shown over `modalOverlay`.

## Do's and Don'ts

- **Do** treat `index.html`'s `[data-theme="premierleague"]` block as the
  single source of truth for these values going forward -- it's the most
  structured, intentional home for them (real CSS custom properties, not
  scattered literals).
- **Don't** retype these hex values by hand in a new surface. Copy them
  from here. See the note below -- that's exactly how the current drift
  happened.
- **Known drift, not yet fixed (flagged, not changed as part of writing
  this file):** `admin.html` and the preview email's own `JB_THEME`
  object both reimplement this same palette independently, by hand, and
  have each drifted slightly from the canonical values and from each
  other:
  - Card background: app `rgba(45, 10, 58, 0.72)` (~`#2d0a3a`) vs. email
    `JB_THEME.cardBg = "#2a0e36"` vs. admin.html's own hardcoded
    `#1e0a28` / `#1b0a24` / `#1c0925` (three more near-but-not-identical
    purples, used in different places within admin.html itself).
  - Card border opacity: app `rgba(255, 40, 130, 0.3)` vs. email
    `JB_THEME.cardBorder`'s `rgba(255, 40, 130, 0.28)` -- a tiny, almost
    certainly accidental 0.02 drift.
  - Background gradient: app uses a **radial** gradient
    (`ellipse at 30% 0%`, stops at 0%/40%/100%) vs. email's `pageGrad`
    using a **linear** gradient (`160deg`, stops at 0%/55%/100%) with the
    same three colors -- different gradient *type*, not just different
    stops. (Likely intentional here specifically -- email clients render
    radial gradients unreliably -- but worth confirming rather than
    assuming.)
  - Corner radius: app's card radius is 16px; the email's card radius is
    12px. Possibly deliberate (a smaller radius is safer across email
    clients), possibly just drift -- also worth confirming rather than
    assuming either way.
