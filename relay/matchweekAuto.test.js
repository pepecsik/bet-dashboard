// Run with: node --test relay/matchweekAuto.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { isMatchStuck, getMatchweekReadiness, londonDateString, addDaysToDateString } from "./matchweekAuto.js";

test("isMatchStuck: normal statuses are never stuck", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  assert.equal(isMatchStuck({ status: "FT" }, now), false);
  assert.equal(isMatchStuck({ status: "NS", kickoffTs: now + 1000 }, now), false); // not kicked off yet
  assert.equal(isMatchStuck({ status: "HT" }, now), false);
  assert.equal(isMatchStuck({ status: "45'" }, now), false);
});

test("isMatchStuck: an unrecognized status (postponed/abandoned/etc) is always stuck", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  for (const status of ["PST", "CANC", "ABD", "SUSP", "AWD", "WO", "INT"]) {
    assert.equal(isMatchStuck({ status, kickoffTs: now - 1000 }, now), true, `${status} should be stuck`);
  }
});

test("isMatchStuck: NS well past its own kickoff time is stuck even though NS is normally fine", () => {
  const kickoff = Date.parse("2026-11-10T15:00:00Z");
  assert.equal(isMatchStuck({ status: "NS", kickoffTs: kickoff }, kickoff + 60 * 60 * 1000), false, "1h late -- still within grace");
  assert.equal(isMatchStuck({ status: "NS", kickoffTs: kickoff }, kickoff + 4 * 60 * 60 * 1000), true, "4h late -- past the 3h grace");
});

test("londonDateString / addDaysToDateString basics", () => {
  assert.equal(londonDateString(Date.parse("2026-11-10T23:30:00Z")), "2026-11-10"); // GMT in November, no DST shift
  assert.equal(addDaysToDateString("2026-11-10", 2), "2026-11-12");
  assert.equal(addDaysToDateString("2026-11-30", 2), "2026-12-02"); // crosses a month boundary
});

const SAT = Date.parse("2026-11-07T15:00:00Z");
const SUN = Date.parse("2026-11-08T15:00:00Z");

function makeMatches(statuses) {
  return [
    { match: "A - B", status: statuses[0], kickoffTs: SAT },
    { match: "C - D", status: statuses[1], kickoffTs: SUN },
  ];
}

test("getMatchweekReadiness: not ready while any match is still live/upcoming", () => {
  const r = getMatchweekReadiness(makeMatches(["FT", "NS"]), SUN + 1000);
  assert.equal(r.allFinished, false);
  assert.equal(r.readyToStart, false);
});

test("getMatchweekReadiness: all FT but the 2-day buffer hasn't elapsed yet", () => {
  const now = Date.parse("2026-11-09T12:00:00Z"); // 1 day after the Sunday match
  const r = getMatchweekReadiness(makeMatches(["FT", "FT"]), now);
  assert.equal(r.allFinished, true);
  assert.equal(r.lastMatchDate, "2026-11-08");
  assert.equal(r.earliestStartDate, "2026-11-10");
  assert.equal(r.readyToStart, false);
});

test("getMatchweekReadiness: all FT and 2+ days have passed -- ready", () => {
  const now = Date.parse("2026-11-10T00:01:00Z"); // exactly 2 days after the Sunday match, early morning
  const r = getMatchweekReadiness(makeMatches(["FT", "FT"]), now);
  assert.equal(r.readyToStart, true);
});

test("getMatchweekReadiness: a stuck match is reported and blocks readiness even past the date", () => {
  const now = Date.parse("2026-11-12T00:01:00Z");
  const r = getMatchweekReadiness(makeMatches(["FT", "PST"]), now);
  assert.deepEqual(r.stuckMatches, ["C - D"]);
  assert.equal(r.allFinished, false);
  assert.equal(r.readyToStart, false);
});

test("getMatchweekReadiness: no matches with a kickoff time -- never ready, never throws", () => {
  const r = getMatchweekReadiness([], Date.now());
  assert.equal(r.readyToStart, false);
  assert.equal(r.lastMatchDate, null);
});
