# Plan: Replace OpenClaw's agentic browser loop with a mostly-deterministic Stagehand flow

## Why

Tonight's session (2026-09-18/19) proved the current approach — a general conversational
LLM agent (via OpenClaw's `agent:acca:main`) doing open-ended multi-step planning for every
Betfair placement run — is both too expensive (~$200+ in one debugging session) and too
unreliable (repeated "narrating instead of acting" stalls from GPT-5 mini, wrong browser
profile picked, Playwright click/type hangs, a real accidental live placement from a missed
env var). Cheaper chat models (Haiku, GPT-5 mini) were tried as drop-in replacements for the
agent's brain and both failed in different ways — Haiku couldn't reliably navigate search,
GPT-5 mini kept ending turns with only prose instead of calling a tool.

Root cause: asking a general chat-completion model to plan *and* execute a whole multi-step
browser job every run is the expensive, flaky part — not the browser automation itself.

Checked and ruled out: Betfair's own API can't replace browser automation for this — the
Sportsbook (fixed-odds accumulator) API is restricted to licensed affiliate partners only;
only the Exchange API (a different product) is open to individual accounts.

## The plan

1. **One-time deep recon pass** on Betfair Sportsbook's Premier League section. Map:
   - Where win/draw/lose markets can be picked directly from the main fixtures list
     (no need to open the match page for these).
   - What the match-page structure looks like for "special" markets (goals over/under,
     correct score, etc.) that do require opening the match page.
   - Actual selectors / DOM structure / navigation paths for all of the above.
2. **Save that map as a structured local reference file** — the source of truth the
   automation reads from, instead of an LLM re-discovering the page from scratch every run.
3. **Build the actual flow as real code** (Stagehand on top of Playwright, running against
   the existing local Chrome/Betfair-logged-in profile — not a cloud VM) against that
   reference:
   - Do all main-page-selectable win/draw/lose legs first, in bulk.
   - Then drill into match pages for the special-market legs.
   - This ordering minimizes page navigations (fewer chances to break, faster runs).
4. **AI only gets invoked for the ~10% the reference file doesn't cover** — an ambiguous
   team/match name, a missing market for a given fixture, or Betfair having changed
   something since the last recon pass. Candidate model: GPT-5 mini (cheap), but this time
   used for narrow, single-step decisions (Stagehand's `act`/`observe`/`extract` primitives)
   rather than open-ended multi-step planning — a structurally different, easier task than
   what caused tonight's stalls.
5. **If something doesn't match the reference file at all, flag it for Winston rather than
   guess.** That's the trigger to redo a small recon pass on just that piece, keeping the
   reference file current instead of silently drifting stale.
6. Anne/OpenClaw's role likely narrows to the notify-and-approve conversational layer
   (screenshots, "press confirm" pings) around this, rather than driving the browser itself
   — final split still TBD.

## Rough cost estimate (unverified until built)

- **Build (one-time):** ~$10-40 in Claude usage, depending on how many iterations the recon
  + scripting takes. Will track actual cost as we go rather than trust this estimate.
- **Per-bet, after built:** ~1-3 cents per bet (worst case maybe closer to a dime), assuming
  ~90% of the flow is plain deterministic code with zero LLM calls, and GPT-5 mini only
  handles the small remaining fraction. Will verify with real token/cost tracking once live,
  same as every other cost claim tonight.

## Status

Not started. Recon pass is the first concrete step — begin there next session.
