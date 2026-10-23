// Decides WHEN it's safe to auto-run the "Start New Matchweek" sequence
// (see runAutoMatchweekSequence() in server.js), and separately flags any
// match that looks stuck (postponed/abandoned/suspended, or one that never
// kicked off on schedule) so Winston gets a Telegram heads-up instead of
// the automation either silently waiting forever or guessing at a result.
//
// Pure/stateless on purpose -- no fetch, no Date.now() default -- so it's
// fully unit-testable. server.js owns all the actual timing/memory (how
// long a match has been stuck, the real clock, Telegram).

// Statuses normalizeStatus()/Code.gs's own normalizeFixtureStatus() hand
// back for a match that's simply progressing normally. Anything else (PST,
// CANC, ABD, SUSP, AWD, WO, or any other raw API-Football code) is never
// converted to one of these -- see normalizeStatus.js -- so it doubles as a
// reliable "something unusual happened" signal on its own, with no need to
// separately enumerate every weird code.
const LIVE_MINUTE_RE = /^\d+'$/;
function isNormalInProgressStatus(status) {
  return status === "NS" || status === "HT" || LIVE_MINUTE_RE.test(String(status || ""));
}

function isFinished(status) {
  return status === "FT";
}

// A match counts as "stuck" once either:
//  - its status is something other than NS/HT/a live minute/FT (a weird
//    code slipped through unchanged by normalizeStatus, e.g. postponed or
//    abandoned), or
//  - it's still showing NS well past its own scheduled kickoff (the status
//    feed may just not have caught up with a real postponement yet).
// nowMs is passed in rather than read here so callers (and tests) control
// the clock explicitly.
const NS_OVERDUE_GRACE_MS = 3 * 60 * 60 * 1000; // 3h past kickoff and still "NS" isn't normal
function isMatchStuck(m, nowMs) {
  if (isFinished(m.status)) return false;
  if (!isNormalInProgressStatus(m.status)) return true;
  if (m.status === "NS" && m.kickoffTs && nowMs - m.kickoffTs > NS_OVERDUE_GRACE_MS) return true;
  return false;
}

// en-CA gives a plain YYYY-MM-DD string directly, no manual reassembly.
function londonDateString(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(ms));
}

// Pure calendar-date arithmetic on a YYYY-MM-DD string -- UTC-anchored so
// it's not sensitive to the host machine's own local timezone, and not
// trying to re-derive a timezone offset a second time (londonDateString()
// already resolved that part).
function addDaysToDateString(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The one function server.js actually calls on each hourly check.
// matches: the current matchweek's data.matches array (status + kickoffTs,
// straight off the plain Apps Script dashboard fetch). nowMs: Date.now(),
// passed in for testability.
function getMatchweekReadiness(matches, nowMs) {
  const withKickoff = (matches || []).filter((m) => m.kickoffTs);
  if (!withKickoff.length) {
    return { allFinished: false, readyToStart: false, lastMatchDate: null, earliestStartDate: null, stuckMatches: [] };
  }
  const stuckMatches = withKickoff.filter((m) => isMatchStuck(m, nowMs)).map((m) => m.match);
  const allFinished = withKickoff.every((m) => isFinished(m.status));
  const lastMatchDate = withKickoff
    .map((m) => londonDateString(m.kickoffTs))
    .reduce((max, d) => (d > max ? d : max));
  const earliestStartDate = addDaysToDateString(lastMatchDate, 2);
  const readyToStart = allFinished && londonDateString(nowMs) >= earliestStartDate;
  return { allFinished, readyToStart, lastMatchDate, earliestStartDate, stuckMatches };
}

export { isMatchStuck, getMatchweekReadiness, londonDateString, addDaysToDateString };
