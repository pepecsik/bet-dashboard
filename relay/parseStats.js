// Mirrors Code.gs's updateAllData() field-by-field exactly -- same raw
// API-Football `statistics` array shape in, same h_*/a_* field names out --
// so index.html's existing stats-rendering code (built against buildDashboard()'s
// output) can consume this without caring whether it came from the Sheet or
// the relay. See updateAllData()'s parseTeamStats() for the source of truth
// this was ported from.
function parseTeamStats(statsArray) {
  const map = {};
  if (!statsArray) return map;
  statsArray.forEach((s) => {
    let key = String(s.type).toLowerCase();
    if (key.includes("possession")) key = "possession";
    else if (key.includes("expected")) key = "xg";
    else if (key.includes("total shots")) key = "shots_total";
    else if (key.includes("on goal")) key = "shots_on";
    else if (key.includes("saves")) key = "saves";
    else if (key.includes("fouls")) key = "fouls";
    else if (key.includes("corner")) key = "corners";
    else if (key.includes("red")) key = "red";
    let val = s.value;
    if (typeof val === "string" && val.includes("%")) val = parseFloat(val);
    map[key] = val === null ? 0 : val;
  });
  return map;
}

// `rawStatistics` is API-Football's own f.statistics -- an array of
// { team, statistics: [{type, value}, ...] }, home first then away, exactly
// as f.statistics comes back from /fixtures?ids= (what updateAllData() uses)
// -- UNCONFIRMED as of this writing whether /fixtures?live=all (what the
// relay's own poll uses) returns the same nested richness. Returns null
// (not a zeroed-out object) when there's nothing to parse, so callers can
// tell "no stats data in this response" apart from "genuinely 0-0 on every
// stat", and degrade gracefully instead of asserting facts about a match
// that hasn't actually reported anything yet.
function parseLiveStats(rawStatistics) {
  if (!rawStatistics || rawStatistics.length < 2) return null;
  const home = parseTeamStats(rawStatistics[0] && rawStatistics[0].statistics);
  const away = parseTeamStats(rawStatistics[1] && rawStatistics[1].statistics);
  return {
    h_xg: home.xg || 0, a_xg: away.xg || 0,
    h_poss: home.possession || 50, a_poss: away.possession || 50,
    h_shots: home.shots_on || 0, a_shots: away.shots_on || 0,
    h_shots_tot: home.shots_total || 0, a_shots_tot: away.shots_total || 0,
    h_saves: home.saves || 0, a_saves: away.saves || 0,
    h_fouls: home.fouls || 0, a_fouls: away.fouls || 0,
    h_corners: home.corners || 0, a_corners: away.corners || 0,
    h_red: home.red || 0, a_red: away.red || 0,
  };
}

// Same shape normalizeStatus.js/scoring.js already write into DATA column
// 13 (M, "scorers") via updateAllData() -- "(H) Player Name, (A) Other Player".
function parseScorers(rawEvents, homeTeamId) {
  if (!rawEvents) return "";
  const scored = [];
  rawEvents.forEach((e) => {
    if (e.type !== "Goal") return;
    const side = e.team && e.team.id === homeTeamId ? "H" : "A";
    scored.push(`(${side}) ${e.player ? e.player.name : ""}`);
  });
  return scored.join(", ");
}

export { parseTeamStats, parseLiveStats, parseScorers };
