// Pure decision logic for rules #4 (big win), #5A (one match away), #5B
// (one goal away, + the merge rule with #5A), and #6 (bet died, batched) --
// given this tick's full state and what's already been notified, returns
// exactly which events to fire plus the updated notified-state to persist.
// No Telegram, no network, so the whole decision tree is testable without
// a live relay or live match data. server.js just calls this, renders each
// returned event to text (telegramMessages.js), sends it, and persists the
// returned notifiedState for the next tick.

import { computeColumnStats, findOneGoalAwayLegs } from "./columnStats.js";

function parseMinute(status) {
  const s = String(status || "").trim();
  const m = s.match(/^(\d+)'?$/);
  return m ? m[1] : s; // numeric minute, or passed through as-is (e.g. "HT")
}

function findMatchByColor(matches, colIdx, colors) {
  return (matches || []).find((m) => {
    const c = (m.cells || [])[colIdx];
    return c && colors.includes(c.color);
  }) || null;
}

// Prefers a GRAY leg (always the dead-causing one -- mathematically
// impossible regardless of FT) over a RED leg, and only a RED leg actually
// at FT counts (mirrors computeColumnStats' own isDead condition exactly).
function findDeadMatch(matches, colIdx) {
  const gray = findMatchByColor(matches, colIdx, ["GRAY"]);
  if (gray) return gray;
  return (matches || []).find((m) => {
    const c = (m.cells || [])[colIdx];
    const st = m.status ? String(m.status).trim().toUpperCase() : "";
    return c && c.color === "RED" && st === "FT";
  }) || null;
}

// notifiedState shape: { bigWin: Set<player>, oneMatchAway: Set<player>,
// dead: Set<player>, oneGoalAwayKeys: Set<string> }. The first three are
// once-ever-per-matchweek guards (reset when a column's hasB goes back to
// false, i.e. bets cleared for a new week); oneGoalAwayKeys instead holds
// the PREVIOUS tick's set of "colIdx:match" keys so a leg leaving and
// re-entering the one-goal-away state can genuinely re-fire.
function detectBetEvents(headers, matches, betSummary, notifiedState) {
  const stats = computeColumnStats(headers, matches, betSummary);
  const oneGoalAwayLegs = findOneGoalAwayLegs(headers, matches);
  const oneGoalAwayByCol = new Map();
  oneGoalAwayLegs.forEach((leg) => {
    if (!oneGoalAwayByCol.has(leg.colIdx)) oneGoalAwayByCol.set(leg.colIdx, leg);
  });

  const nextBigWin = new Set(notifiedState.bigWin);
  const nextOneMatchAway = new Set(notifiedState.oneMatchAway);
  const nextDead = new Set(notifiedState.dead);
  const currentOneGoalAwayKeys = new Set(oneGoalAwayLegs.map((l) => `${l.colIdx}:${l.match}`));
  const suppressedLegKeys = new Set();

  const events = [];
  const deaths = [];

  stats.forEach((s, colIdx) => {
    if (!s.hasB) {
      // Cleared for a new matchweek -- reset this player's guards.
      nextBigWin.delete(s.player);
      nextOneMatchAway.delete(s.player);
      nextDead.delete(s.player);
      return;
    }

    if (s.allGreen && !nextBigWin.has(s.player)) {
      nextBigWin.add(s.player);
      events.push({ type: "bigWin", player: s.player, amount: s.tot });
    }

    if (s.orangeCount === 1 && s.redCount === 0 && !nextOneMatchAway.has(s.player)) {
      nextOneMatchAway.add(s.player);
      const leg = oneGoalAwayByCol.get(colIdx);
      if (leg) {
        suppressedLegKeys.add(`${leg.colIdx}:${leg.match}`);
        events.push({
          type: "oneGoalAwayAndLastLeg", player: s.player, amount: s.tot, match: leg.match,
          homeCode: leg.homeCode, awayCode: leg.awayCode, pick: leg.pick, score: leg.score, minute: parseMinute(leg.status),
        });
      } else {
        const orangeMatch = findMatchByColor(matches, colIdx, ["ORANGE"]);
        events.push({ type: "oneMatchAway", player: s.player, amount: s.tot, match: orangeMatch ? orangeMatch.match : "?" });
      }
    }

    if (s.isDead && !nextDead.has(s.player)) {
      nextDead.add(s.player);
      const deadMatch = findDeadMatch(matches, colIdx);
      deaths.push({ player: s.player, match: deadMatch ? deadMatch.match : "?", finalScore: deadMatch ? deadMatch.score : "?" });
    }
  });

  if (deaths.length) events.push({ type: "deaths", entries: deaths });

  oneGoalAwayLegs.forEach((leg) => {
    const key = `${leg.colIdx}:${leg.match}`;
    if (suppressedLegKeys.has(key)) return; // already folded into the merged 5A+5B event above
    if (notifiedState.oneGoalAwayKeys.has(key)) return; // not newly entered this tick
    events.push({
      type: "oneGoalAway", player: leg.player, match: leg.match,
      homeCode: leg.homeCode, awayCode: leg.awayCode, pick: leg.pick, score: leg.score, minute: parseMinute(leg.status),
    });
  });

  return {
    events,
    notifiedState: { bigWin: nextBigWin, oneMatchAway: nextOneMatchAway, dead: nextDead, oneGoalAwayKeys: currentOneGoalAwayKeys },
  };
}

function emptyNotifiedState() {
  return { bigWin: new Set(), oneMatchAway: new Set(), dead: new Set(), oneGoalAwayKeys: new Set() };
}

export { detectBetEvents, emptyNotifiedState, parseMinute };
