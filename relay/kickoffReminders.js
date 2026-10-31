// Pure trigger logic for rules #3A (first kickoff in 30 min) and #3B
// (day-before "place your bets" reminder) -- same split as every other
// pure module here, wired into server.js's own setInterval check.

// Europe/London reference timezone, same convention matchweekAuto.js
// already uses for its own kickoff-date formatting.
function londonTime(ms) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

// The earliest kickoff this week, plus every match sharing that exact
// timestamp -- handles simultaneous kickoffs (e.g. several Saturday 3pm
// games) as one group rather than just the single earliest match.
function getEarliestKickoffGroup(matches) {
  let earliestTs = null;
  (matches || []).forEach((m) => {
    if (!m.kickoffTs) return;
    const ts = new Date(m.kickoffTs).getTime();
    if (Number.isNaN(ts)) return;
    if (earliestTs === null || ts < earliestTs) earliestTs = ts;
  });
  if (earliestTs === null) return { ts: null, matches: [] };
  const group = (matches || [])
    .filter((m) => m.kickoffTs && new Date(m.kickoffTs).getTime() === earliestTs)
    .map((m) => ({ match: m.match, time: londonTime(earliestTs) }));
  return { ts: earliestTs, matches: group };
}

function shouldFireKickoff30Min(earliestTs, nowMs) {
  if (earliestTs === null) return false;
  return nowMs >= earliestTs - 30 * 60 * 1000;
}

function shouldFireDayBefore(earliestTs, nowMs) {
  if (earliestTs === null) return false;
  return nowMs >= earliestTs - 24 * 60 * 60 * 1000;
}

// Every header has a recorded WIN value -- real-money Betano placement
// confirmed for everyone this week (same winCells source #4's big-win rule
// already reads).
function everyoneHasPlaced(headers, winCells) {
  if (!headers || !headers.length) return false;
  return headers.every((h, i) => {
    const c = (winCells || [])[i];
    return !!(c && Number(c.value) > 0);
  });
}

export { londonTime, getEarliestKickoffGroup, shouldFireKickoff30Min, shouldFireDayBefore, everyoneHasPlaced };
