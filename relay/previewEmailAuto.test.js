// Run with: node --test relay/previewEmailAuto.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { isWhatIfVisible, allBetsLocked, hasFirstBetGames } from "./previewEmailAuto.js";

function makeData({ headerStatuses, winValues, firstBetFlags }) {
  return {
    headers: headerStatuses.map((status) => ({ status })),
    betSummary: [null, { cells: winValues.map((v) => ({ value: v })) }],
    matches: firstBetFlags.map((f, i) => ({ match: "M" + i, isFirstBetGame: f })),
  };
}

test("allBetsLocked: false with no headers at all", () => {
  assert.equal(allBetsLocked({ headers: [], betSummary: [], matches: [] }), false);
});

test("allBetsLocked: true once every column is either dead (red) or has a WIN value", () => {
  const data = makeData({ headerStatuses: [null, "red", null], winValues: [5, 0, 12.5], firstBetFlags: [] });
  assert.equal(allBetsLocked(data), true);
});

test("allBetsLocked: false while any still-alive column has no WIN value yet", () => {
  const data = makeData({ headerStatuses: [null, "red", null], winValues: [5, 0, 0], firstBetFlags: [] });
  assert.equal(allBetsLocked(data), false);
});

test("hasFirstBetGames: true only once at least one match is flagged", () => {
  assert.equal(hasFirstBetGames(makeData({ headerStatuses: [], winValues: [], firstBetFlags: [false, false] })), false);
  assert.equal(hasFirstBetGames(makeData({ headerStatuses: [], winValues: [], firstBetFlags: [false, true] })), true);
});

test("isWhatIfVisible: needs both allBetsLocked AND a first-bet game", () => {
  const locked = { headerStatuses: ["red"], winValues: [0] };
  assert.equal(isWhatIfVisible(makeData({ ...locked, firstBetFlags: [false] })), false, "locked but no first-bet game");
  assert.equal(isWhatIfVisible(makeData({ ...locked, firstBetFlags: [true] })), true, "locked and has a first-bet game");

  const notLocked = { headerStatuses: [null], winValues: [0] };
  assert.equal(isWhatIfVisible(makeData({ ...notLocked, firstBetFlags: [true] })), false, "first-bet game present but not locked yet");
});
