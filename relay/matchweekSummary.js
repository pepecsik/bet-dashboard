// Server-side port of admin.html's computeLiveSummary() -- same rules,
// same field names. Used by the automated "Start New Matchweek" sequence
// (see runAutoMatchweekSequence() in server.js) to build the exact payload
// adminSaveMatchweek expects, the same way the manual button already does
// via admin.html's own copy. Kept here (not shared/imported from
// admin.html, which isn't a module) so it has its own tests instead of
// only ever being exercised by hand through the browser -- and so a future
// change to one copy doesn't silently drift from the other unnoticed.

const SB_PLAYERS = ["Snackbar", "Timbo", "Pepe", "Sjaak"];

// Same green/red hex lists the main page/admin.html use to read the
// sheet's own conditional-formatting colors, so a bet counts as "correct"
// here exactly when it would show green on the main dashboard.
const SB_GREEN = ["#7cff5b", "#00ff00", "#b6d7a8", "#93c47d", "#6aa84f", "#38761d", "#d9ead3"];
const SB_RED = ["#ff0000", "#ff4d4d", "red"];
const sbIsGreen = (hex) => !!hex && SB_GREEN.includes(String(hex).toLowerCase());
const sbIsRed = (hex) => !!hex && SB_RED.includes(String(hex).toLowerCase());

// Live points + money for each player, computed the same way the backend's
// syncCurrentMatchweekToHistory does: 1pt per correct FT bet, 3pt if it was
// an exact correct-score pick; money only counted once a whole header
// column has actually won.
function computeWeeklySummary(data) {
  const summary = {};
  SB_PLAYERS.forEach((p) => { summary[p] = { points: 0, money: 0 }; });

  (data.matches || []).forEach((m) => {
    if (m.status !== "FT") return;
    SB_PLAYERS.forEach((p) => {
      const cells = (m.scoreboardCells && m.scoreboardCells[p]) || [];
      cells.forEach((c) => {
        if (!c.value || !sbIsGreen(c.color)) return;
        const isScore = /^\d+\s*-\s*\d+$/.test(String(c.value).trim());
        summary[p].points += isScore ? 3 : 1;
      });
    });
  });

  // Money -- the WIN row (data.betSummary[1]) is a single combo value per
  // header column, covering every match assigned to that column. It's only
  // real, won money once every one of those matches is FT and correct, with
  // no misses.
  (data.headers || []).forEach((h, i) => {
    if (!SB_PLAYERS.includes(h.name)) return;
    let hasBet = false, hasRed = false, allGreen = true, pending = 0;
    (data.matches || []).forEach((m) => {
      const c = m.cells && m.cells[i];
      if (!c || !c.value) return;
      hasBet = true;
      if (!sbIsGreen(c.color)) allGreen = false;
      if (sbIsRed(c.color)) hasRed = true;
      if (m.status !== "FT") pending++;
    });
    if (!hasBet || hasRed || !allGreen || pending > 0) return;
    if (data.betSummary && data.betSummary[1] && data.betSummary[1].cells[i]) {
      summary[h.name].money += data.betSummary[1].cells[i].value || 0;
    }
  });

  return summary;
}

export { computeWeeklySummary, SB_PLAYERS };
