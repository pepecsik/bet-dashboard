// Pure logic for the "day/week points wrap" notification: after the last
// match of a day finishes, post each player's points gained this matchweek
// so far (cumulative across the days already played) plus what that'd make
// their season total. The final day of the week gets different wording.
//
// Deliberately does NOT compute "points gained today" as its own number --
// Winston confirmed the "+N" figure is the week-to-date total, not a daily
// delta, so this needs no day-to-day snapshot/diffing at all: whatever
// computeWeeklySummary() returns at the moment a day completes already IS
// that number, since it only ever counts FT matches.

const SB_PLAYERS = ["Snackbar", "Timbo", "Pepe", "Sjaak"];

function londonDateKey(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(ms)); // en-CA => YYYY-MM-DD
}

// Groups matches that have a kickoffTs by their London calendar date,
// sorted chronologically. Matches without a kickoffTs are ignored -- can't
// place them in a day.
function groupMatchesByDay(matches) {
  const byDate = new Map();
  (matches || []).forEach((m) => {
    if (!m.kickoffTs) return;
    const ts = new Date(m.kickoffTs).getTime();
    if (Number.isNaN(ts)) return;
    const key = londonDateKey(ts);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(m);
  });
  return Array.from(byDate.entries())
    .map(([dateKey, dayMatches]) => ({ dateKey, matches: dayMatches }))
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
}

// Every day whose matches are ALL FT, not already in `wrappedDates`, in
// chronological order. "All FT" (not "the temporally-last match is FT")
// is what makes this safe for two matches kicking off together: if one
// goes to extra time, the day simply isn't complete yet regardless of
// where either match sits in the fixture list.
function getNewlyCompletedDays(matches, wrappedDates) {
  const days = groupMatchesByDay(matches);
  if (!days.length) return [];
  const lastDateKey = days[days.length - 1].dateKey;
  return days
    .filter((d) => !wrappedDates.has(d.dateKey))
    .filter((d) => d.matches.every((m) => String(m.status || "").trim().toUpperCase() === "FT"))
    .map((d) => ({ dateKey: d.dateKey, isLastDay: d.dateKey === lastDateKey }));
}

// All known day-dates for the current matchweek's matches -- used to detect
// "this is a new matchweek" (the date set no longer matches what was
// tracked) so wrappedDates can reset, same spirit as every other
// once-per-matchweek guard in this relay.
function weekDateKeys(matches) {
  return new Set(groupMatchesByDay(matches).map((d) => d.dateKey));
}

// weekSummary: computeWeeklySummary()'s return value (points this week,
// per player, used only for the "+N" figure and as the primary sort key).
// ranking: the live dashboard's ranking array -- Code.gs's buildDashboard()
// re-syncs the current matchweek's HISTORY row live on every single load
// (syncCurrentMatchweekToHistory(), well before "Save Matchweek" locks it),
// and RANKING sums HISTORY, so by the time this relay reads `ranking` it
// ALREADY includes this week's points-so-far. Adding weekPoints on top of
// it here double-counted this week's points into the season total (caught
// live: a reported total was consistently exactly weekPoints higher than
// the real one). Returns rows sorted by this week's points (desc), ties
// broken by the resulting season total (desc) -- matches Winston's
// explicit ask.
function buildWeekPointsRanking(weekSummary, ranking) {
  const seasonByPlayer = {};
  (ranking || []).forEach((r) => { seasonByPlayer[r.name] = Number(r.matchesRight) || 0; });

  const rows = SB_PLAYERS.map((player) => {
    const weekPoints = (weekSummary && weekSummary[player] && weekSummary[player].points) || 0;
    const seasonTotal = seasonByPlayer[player] || 0;
    return { player, weekPoints, seasonTotal };
  });

  rows.sort((a, b) => b.weekPoints - a.weekPoints || b.seasonTotal - a.seasonTotal);
  return rows;
}

export { londonDateKey, groupMatchesByDay, getNewlyCompletedDays, weekDateKeys, buildWeekPointsRanking, SB_PLAYERS };
