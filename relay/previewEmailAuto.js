// Decides whether the "What if?" column is currently visible in the app --
// the signal Winston wants the matchweek preview email's auto-send timer
// to key off of ("as soon as What if? becomes visible, 5 min later").
//
// Mirrors index.html's own two-part check exactly (window.allLocked &&
// getFirstBetGames().length > 0), just read off the cheap ?mode=fast
// payload instead of recomputed client-side: a header counts as resolved
// once it's either dead (red) or has a WIN value written in, and at least
// one match has to actually be a shared "first bet" game for the column to
// mean anything. Pure/stateless -- server.js owns the actual polling,
// scheduling and the real clock.

function allBetsLocked(data) {
  const headers = data.headers || [];
  const winCells = (data.betSummary && data.betSummary[1] && data.betSummary[1].cells) || [];
  if (!headers.length) return false;
  return headers.every((h, i) => h.status === "red" || !!(winCells[i] && winCells[i].value));
}

function hasFirstBetGames(data) {
  return (data.matches || []).some((m) => m.isFirstBetGame);
}

function isWhatIfVisible(data) {
  return allBetsLocked(data) && hasFirstBetGames(data);
}

export { isWhatIfVisible, allBetsLocked, hasFirstBetGames };
