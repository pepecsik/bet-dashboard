// Run with: node --test relay/weekPointsWrap.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { londonDateKey, groupMatchesByDay, getNewlyCompletedDays, weekDateKeys, buildWeekPointsRanking } from "./weekPointsWrap.js";

// Friday 2026-11-06 20:00 UK time, Saturday 2026-11-07 15:00 x2 (simultaneous), Sunday 2026-11-08 14:00
const FRI = Date.parse("2026-11-06T20:00:00Z");
const SAT = Date.parse("2026-11-07T15:00:00Z");
const SAT2 = Date.parse("2026-11-07T15:00:00Z"); // same kickoff as SAT, different match
const SUN = Date.parse("2026-11-08T14:00:00Z");

test("londonDateKey formats as YYYY-MM-DD in UK time", () => {
  assert.equal(londonDateKey(FRI), "2026-11-06");
});

test("groupMatchesByDay groups by London calendar date, sorted chronologically, ignores matches with no kickoffTs", () => {
  const matches = [
    { match: "SUN A", kickoffTs: SUN, status: "NS" },
    { match: "FRI A", kickoffTs: FRI, status: "FT" },
    { match: "no kickoff", status: "NS" },
    { match: "SAT A", kickoffTs: SAT, status: "FT" },
  ];
  const days = groupMatchesByDay(matches);
  assert.deepEqual(days.map((d) => d.dateKey), ["2026-11-06", "2026-11-07", "2026-11-08"]);
  assert.equal(days[0].matches[0].match, "FRI A");
});

test("getNewlyCompletedDays: a day with every match FT and not yet wrapped is returned", () => {
  const matches = [{ match: "FRI A", kickoffTs: FRI, status: "FT" }];
  const days = getNewlyCompletedDays(matches, new Set());
  assert.equal(days.length, 1);
  assert.equal(days[0].dateKey, "2026-11-06");
  assert.equal(days[0].isLastDay, true); // only day this week
});

test("getNewlyCompletedDays: already-wrapped dates are skipped", () => {
  const matches = [{ match: "FRI A", kickoffTs: FRI, status: "FT" }];
  const days = getNewlyCompletedDays(matches, new Set(["2026-11-06"]));
  assert.deepEqual(days, []);
});

test("getNewlyCompletedDays: does NOT fire while any match that day is still unfinished, regardless of list order", () => {
  // Two matches kick off at the same time; the one earlier in the array is
  // FT, the other (e.g. deep into extra time) is not -- must still wait.
  const matches = [
    { match: "SAT A", kickoffTs: SAT, status: "FT" },
    { match: "SAT B", kickoffTs: SAT2, status: "105'" },
  ];
  assert.deepEqual(getNewlyCompletedDays(matches, new Set()), []);
});

test("getNewlyCompletedDays: fires once the simultaneous pair both reach FT", () => {
  const matches = [
    { match: "SAT A", kickoffTs: SAT, status: "FT" },
    { match: "SAT B", kickoffTs: SAT2, status: "FT" },
  ];
  const days = getNewlyCompletedDays(matches, new Set());
  assert.equal(days.length, 1);
});

test("getNewlyCompletedDays: only the latest day-date is flagged isLastDay", () => {
  const matches = [
    { match: "FRI A", kickoffTs: FRI, status: "FT" },
    { match: "SUN A", kickoffTs: SUN, status: "FT" },
  ];
  const days = getNewlyCompletedDays(matches, new Set());
  const fri = days.find((d) => d.dateKey === "2026-11-06");
  const sun = days.find((d) => d.dateKey === "2026-11-08");
  assert.equal(fri.isLastDay, false);
  assert.equal(sun.isLastDay, true);
});

test("getNewlyCompletedDays: catches up on multiple days at once if more than one newly qualifies", () => {
  const matches = [
    { match: "FRI A", kickoffTs: FRI, status: "FT" },
    { match: "SAT A", kickoffTs: SAT, status: "FT" },
  ];
  const days = getNewlyCompletedDays(matches, new Set());
  assert.equal(days.length, 2);
});

test("weekDateKeys returns the set of day-dates for the current matches, used to detect a new matchweek", () => {
  const matches = [{ match: "FRI A", kickoffTs: FRI }, { match: "SAT A", kickoffTs: SAT }];
  const keys = weekDateKeys(matches);
  assert.deepEqual([...keys].sort(), ["2026-11-06", "2026-11-07"]);
});

test("buildWeekPointsRanking: season total is read straight from ranking (already includes this week's points) -- not added to weekPoints again", () => {
  const weekSummary = { Snackbar: { points: 4, money: 0 }, Timbo: { points: 1, money: 0 }, Pepe: { points: 2, money: 0 }, Sjaak: { points: 0, money: 0 } };
  // These ranking totals already reflect this week's live, in-progress
  // points -- RANKING sums HISTORY, which buildDashboard() keeps synced on
  // every load, well before "Save Matchweek" locks the current week's row.
  const ranking = [{ name: "Snackbar", matchesRight: 68 }, { name: "Timbo", matchesRight: 52 }, { name: "Pepe", matchesRight: 64 }, { name: "Sjaak", matchesRight: 25 }];
  const rows = buildWeekPointsRanking(weekSummary, ranking);
  assert.deepEqual(rows, [
    { player: "Snackbar", weekPoints: 4, seasonTotal: 68 },
    { player: "Pepe", weekPoints: 2, seasonTotal: 64 },
    { player: "Timbo", weekPoints: 1, seasonTotal: 52 },
    { player: "Sjaak", weekPoints: 0, seasonTotal: 25 },
  ]);
});

test("buildWeekPointsRanking: sorts by week points first, ties broken by season total", () => {
  const weekSummary = { Snackbar: { points: 10, money: 0 }, Timbo: { points: 3, money: 0 }, Pepe: { points: 3, money: 0 }, Sjaak: { points: 1, money: 0 } };
  const ranking = [{ name: "Snackbar", matchesRight: 68 }, { name: "Timbo", matchesRight: 53 }, { name: "Pepe", matchesRight: 63 }, { name: "Sjaak", matchesRight: 25 }];
  const rows = buildWeekPointsRanking(weekSummary, ranking);
  assert.deepEqual(rows.map((r) => r.player), ["Snackbar", "Pepe", "Timbo", "Sjaak"]); // Pepe (63) beats Timbo (53) on the tie
});

test("buildWeekPointsRanking: a player missing from the ranking array still gets a row, season total 0", () => {
  const weekSummary = { Snackbar: { points: 2, money: 0 }, Timbo: { points: 0, money: 0 }, Pepe: { points: 0, money: 0 }, Sjaak: { points: 0, money: 0 } };
  const rows = buildWeekPointsRanking(weekSummary, []);
  assert.equal(rows.find((r) => r.player === "Snackbar").seasonTotal, 0);
});
