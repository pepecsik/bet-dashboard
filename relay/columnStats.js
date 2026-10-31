// Per-column (per-bet) live state, derived from the same GREEN/ORANGE/RED/
// GRAY vocabulary scoring.js already produces (see combine.js) -- ported
// from index.html's own computeColumnStats(), just reading the relay's
// string color codes instead of index.html's hex colors (no need to port
// isCorrectColor/isWrongColor/etc. at all, the relay's own color field
// already IS that classification).
function computeColumnStats(headers, matches, betSummary) {
  return (headers || []).map((h, i) => {
    let hasB = false, hasDeadFT = false, grayCount = 0, orangeCount = 0, redCount = 0, allGreen = true;
    (matches || []).forEach((m) => {
      const c = (m.cells || [])[i];
      const st = m.status ? String(m.status).trim().toUpperCase() : "";
      if (!c || !c.value) return;
      hasB = true;
      if (c.color !== "GREEN") allGreen = false;
      if (c.color === "RED") {
        redCount++;
        if (st === "FT") hasDeadFT = true;
      }
      if (c.color === "GRAY") grayCount++;
      if (c.color === "ORANGE") orangeCount++;
    });
    const isDead = hasDeadFT || grayCount > 0;
    let tot = 0;
    if (hasB && betSummary && betSummary[1] && betSummary[1].cells && betSummary[1].cells[i]) {
      tot = Number(betSummary[1].cells[i].value) || 0;
    }
    return { player: h.name, hasB, isDead, allGreen, orangeCount, redCount, tot };
  });
}

// A normalized status counts as "live" (match actually in play or at half
// time, not NS/FT/PST/etc) -- mirrors normalizeStatus.js's own output
// shapes ("NN'", "FT", "NS", "HT", or a passthrough code).
function isLiveStatus(status) {
  const s = String(status || "").trim().toUpperCase();
  return s === "HT" || /^\d+'?$/.test(s) || /\d+'$/.test(s);
}

// Every column+match combo currently "one goal away" -- ORANGE on a LIVE
// match (isLiveStatus guards out the pre-kickoff false-positive: a 0-0 NS
// match scores ORANGE for a home/away-win pick too, same tie condition,
// but nothing's actually live yet), for a plain win/draw/away pick only
// (bet === home/away code or "X") -- deliberately excludes exact-score and
// goals-market picks, which also use ORANGE for a different "one away"
// concept (one goal/line away from an exact number, not from a result).
function findOneGoalAwayLegs(headers, matches) {
  const results = [];
  (matches || []).forEach((m) => {
    if (!isLiveStatus(m.status)) return;
    const home = String(m.homeCode || "").trim().toUpperCase();
    const away = String(m.awayCode || "").trim().toUpperCase();
    (headers || []).forEach((h, i) => {
      const c = (m.cells || [])[i];
      if (!c || !c.value || c.color !== "ORANGE") return;
      const bet = String(c.value).trim().toUpperCase();
      const isPlainPick = bet === "X" || (home && bet === home) || (away && bet === away);
      if (!isPlainPick) return;
      results.push({ colIdx: i, player: h.name, match: m.match, homeCode: m.homeCode, awayCode: m.awayCode, pick: bet, score: m.score, status: m.status });
    });
  });
  return results;
}

export { computeColumnStats, findOneGoalAwayLegs, isLiveStatus };
