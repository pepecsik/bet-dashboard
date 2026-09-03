// Faithful JS port of the DASHBOARD conditional-formatting formula (the
// version fixed 2026-09-03 -- away goals read from the same row's AwayGoals
// column, not a neighbouring row's TotalGoals). This becomes the ONE place
// bet outcome colour gets decided once the fast layer is live: Sheets
// stops computing it independently and just stores what this says.
//
// Returns "GREEN" | "ORANGE" | "RED" | "" -- the same vocabulary the rest
// of the app already reads off Sheets' own cell colours.
//
// Kept as a plain, dependency-free function so it can be unit-tested in
// isolation (see scoring.test.js) before anything wires it into the live
// push path -- this is the one piece of the fast/slow split that decides
// who's owed what, so it gets proven correct on its own first.

function scoreBet({ bet, homeGoals, awayGoals, status, yellowCards, redCards, scorers, homeCode, awayCode }) {
  const b = String(bet || "").trim().toUpperCase();
  if (!b) return "";

  const hg = Number(homeGoals) || 0;
  const ag = Number(awayGoals) || 0;
  const tg = hg + ag;
  const isFT = String(status || "") === "FT";
  const yc = Number(yellowCards) || 0;
  const rc = Number(redCards) || 0;
  const sc = String(scorers || "").toUpperCase();
  const home = String(homeCode || "").trim().toUpperCase();
  const away = String(awayCode || "").trim().toUpperCase();

  // 1. Exact score, e.g. "3-1"
  const scoreMatch = b.match(/^(\d+)\s*-\s*(\d+)$/);
  if (scoreMatch) {
    const eh = parseInt(scoreMatch[1], 10);
    const ea = parseInt(scoreMatch[2], 10);
    const exact = hg === eh && ag === ea;
    if (isFT) return exact ? "GREEN" : "RED";
    if (exact) return "GREEN";
    if (hg > eh || ag > ea) return "RED"; // busted -- goals only go up, this can't land right anymore
    const remaining = (eh + ea) - (hg + ag);
    return remaining === 1 ? "ORANGE" : "RED";
  }

  // 2. Goalscorer -- anything that isn't one of the other recognized
  // markets and isn't a team code is treated as a player name.
  const isNamedMarket = b === "X" || b.startsWith("GOALS") || b.startsWith("YELLOW C") || b.startsWith("RED C") || b === home || b === away;
  if (!isNamedMarket) {
    const scored = sc.includes(b);
    if (isFT) return scored ? "GREEN" : "RED";
    return scored ? "GREEN" : "ORANGE";
  }

  // Shared "over N.5" shape for goals / yellow cards / red cards.
  function overUnder(actual) {
    const m = b.match(/([0-9]+)[.,]5/);
    if (!m) return "";
    const needed = parseInt(m[1], 10) + 1;
    if (isFT) return actual >= needed ? "GREEN" : "RED";
    if (actual >= needed) return "GREEN";
    return actual === needed - 1 ? "ORANGE" : "RED";
  }

  if (b.startsWith("GOALS")) return overUnder(tg);
  if (b.startsWith("YELLOW C")) return overUnder(yc);
  if (b.startsWith("RED C")) return overUnder(rc);

  // 3. Draw
  if (b === "X") {
    if (isFT) return hg === ag ? "GREEN" : "RED";
    const diff = Math.abs(hg - ag);
    if (diff === 0) return "GREEN";
    return diff === 1 ? "ORANGE" : "RED";
  }

  // 4. Home win
  if (b === home) {
    if (isFT) return hg > ag ? "GREEN" : "RED";
    if (hg > ag) return "GREEN";
    return hg === ag ? "ORANGE" : "RED";
  }

  // 5. Away win
  if (b === away) {
    if (isFT) return ag > hg ? "GREEN" : "RED";
    if (ag > hg) return "GREEN";
    return ag === hg ? "ORANGE" : "RED";
  }

  return "";
}

export { scoreBet };
