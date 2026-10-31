// Run with: node --test relay/kickoffReminders.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { getEarliestKickoffGroup, shouldFireKickoff30Min, shouldFireDayBefore, everyoneHasPlaced } from "./kickoffReminders.js";

test("getEarliestKickoffGroup: finds the earliest and groups every match sharing it", () => {
  const sameTs = Date.UTC(2026, 10, 1, 15, 0);
  const matches = [
    { match: "ARS - CHE", kickoffTs: sameTs },
    { match: "TOT - WHA", kickoffTs: sameTs },
    { match: "LIV - MCI", kickoffTs: sameTs + 2 * 60 * 60 * 1000 }, // later kickoff, excluded
  ];
  const { ts, matches: group } = getEarliestKickoffGroup(matches);
  assert.equal(ts, sameTs);
  assert.equal(group.length, 2);
  assert.deepEqual(group.map((m) => m.match).sort(), ["ARS - CHE", "TOT - WHA"]);
});

test("getEarliestKickoffGroup: no matches with a kickoffTs returns null group", () => {
  assert.deepEqual(getEarliestKickoffGroup([]), { ts: null, matches: [] });
  assert.deepEqual(getEarliestKickoffGroup([{ match: "ARS - CHE" }]), { ts: null, matches: [] });
});

test("shouldFireKickoff30Min: fires at and after the 30-minute mark, not before", () => {
  const kickoff = Date.UTC(2026, 10, 1, 15, 0);
  assert.equal(shouldFireKickoff30Min(kickoff, kickoff - 31 * 60 * 1000), false);
  assert.equal(shouldFireKickoff30Min(kickoff, kickoff - 30 * 60 * 1000), true);
  assert.equal(shouldFireKickoff30Min(kickoff, kickoff - 10 * 60 * 1000), true);
  assert.equal(shouldFireKickoff30Min(null, Date.now()), false);
});

test("shouldFireDayBefore: fires at and after 24h before, not before", () => {
  const kickoff = Date.UTC(2026, 10, 1, 15, 0);
  assert.equal(shouldFireDayBefore(kickoff, kickoff - 25 * 60 * 60 * 1000), false);
  assert.equal(shouldFireDayBefore(kickoff, kickoff - 24 * 60 * 60 * 1000), true);
  assert.equal(shouldFireDayBefore(kickoff, kickoff - 1 * 60 * 60 * 1000), true);
});

test("everyoneHasPlaced: true only when every header has a positive winCell", () => {
  const headers = [{ name: "Snackbar" }, { name: "Timbo" }];
  assert.equal(everyoneHasPlaced(headers, [{ value: 10 }, { value: 20 }]), true);
  assert.equal(everyoneHasPlaced(headers, [{ value: 10 }, { value: 0 }]), false);
  assert.equal(everyoneHasPlaced(headers, [{ value: 10 }]), false); // Timbo's cell missing entirely
  assert.equal(everyoneHasPlaced([], []), false);
});
