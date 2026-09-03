// Fast/slow split, Phase 3: combines a bets snapshot (from Code.gs's
// ?mode=bets, see server.js's fetchBetsSnapshot) with live scores (from
// this relay's own API-Football poll, keyed by real fixture ID) using the
// ported scoring formula (scoring.js) -- this is the actual computed board
// server.js pushes to clients and serves at GET /snapshot.
//
// A pure function of its two inputs (no reading of server.js's own module
// state) so it can be unit-tested in isolation, same as scoring.js.
//
// Known gap: yellow/red-card and goalscorer bets need live cards/events
// data this relay doesn't fetch yet (API-Football's bulk live-fixtures
// listing doesn't include it -- would need a separate call per match).
// Rather than guess wrong on those specific cells, they're left uncomputed
// (color: null) so a client falls back to whatever it already had for them.

import { scoreBet } from "./scoring.js";

function combineState(betsCache, lastKnown) {
  const matches = (betsCache.matches || []).map((m) => {
    const live = m.fixtureId ? lastKnown.get(m.fixtureId) : null;
    const status = live ? live.status : "NS";
    const score = live ? live.score : "";
    const parts = String(score || "0-0").split("-").map((n) => parseInt(n, 10));
    const homeGoals = Number.isFinite(parts[0]) ? parts[0] : 0;
    const awayGoals = Number.isFinite(parts[1]) ? parts[1] : 0;

    const cells = (m.cells || []).map((c) => {
      const bet = String(c.value || "").trim().toUpperCase();
      if (!bet) return { value: c.value, color: "" };

      const isExactScore = /^\d+\s*-\s*\d+$/.test(bet);
      const isCardsMarket = bet.startsWith("YELLOW C") || bet.startsWith("RED C");
      const isGoalsMarket = bet.startsWith("GOALS");
      const isTeamOrDraw = bet === "X" || bet === m.homeCode || bet === m.awayCode;
      const isScorerGuess = !isExactScore && !isCardsMarket && !isGoalsMarket && !isTeamOrDraw;

      if (isCardsMarket || isScorerGuess) return { value: c.value, color: null };

      const color = scoreBet({
        bet: c.value, homeGoals, awayGoals, status,
        homeCode: m.homeCode, awayCode: m.awayCode,
      });
      return { value: c.value, color };
    });

    return { match: m.match, fixtureId: m.fixtureId, status, score, cells };
  });

  // Passed straight through, not recomputed -- the £ WIN amount per column
  // is a Sheets-side stake calculation, not part of what this combines.
  const winCells = betsCache.winCells || [];

  return { headers: betsCache.headers || [], matches, winCells, computedAt: Date.now() };
}

export { combineState };
