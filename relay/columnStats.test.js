// Run with: node --test relay/columnStats.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { computeColumnStats, findOneGoalAwayLegs, isLiveStatus } from "./columnStats.js";

test("isLiveStatus recognizes in-play minutes and HT, rejects NS/FT", () => {
  assert.equal(isLiveStatus("23'"), true);
  assert.equal(isLiveStatus("90'"), true);
  assert.equal(isLiveStatus("HT"), true);
  assert.equal(isLiveStatus("NS"), false);
  assert.equal(isLiveStatus("FT"), false);
  assert.equal(isLiveStatus("PST"), false);
});

const headers = [{ name: "Snackbar", idx: 3 }, { name: "Timbo", idx: 5 }];
const betSummary = [null, { cells: [{ value: 47.52 }, { value: 12.3 }] }];

test("computeColumnStats: allGreen true only when every placed leg is GREEN", () => {
  const matches = [
    { status: "FT", cells: [{ value: "ARS", color: "GREEN" }, { value: "X", color: "GREEN" }] },
    { status: "FT", cells: [{ value: "CHE", color: "GREEN" }, { value: "2-1", color: "RED" }] },
  ];
  const stats = computeColumnStats(headers, matches, betSummary);
  assert.equal(stats[0].allGreen, true);
  assert.equal(stats[0].hasB, true);
  assert.equal(stats[0].tot, 47.52);
  assert.equal(stats[1].allGreen, false);
  assert.equal(stats[1].redCount, 1);
});

test("computeColumnStats: isDead on a RED leg at FT, or any GRAY leg even pre-FT", () => {
  const redAtFT = computeColumnStats(headers, [{ status: "FT", cells: [{ value: "ARS", color: "RED" }] }], betSummary);
  assert.equal(redAtFT[0].isDead, true);

  const redStillLive = computeColumnStats(headers, [{ status: "63'", cells: [{ value: "ARS", color: "RED" }] }], betSummary);
  assert.equal(redStillLive[0].isDead, false); // not FT yet -- could still land after FT per the sheet's own rule

  const grayStillLive = computeColumnStats(headers, [{ status: "63'", cells: [{ value: "2-1", color: "GRAY" }] }], betSummary);
  assert.equal(grayStillLive[0].isDead, true); // mathematically impossible, dead immediately regardless of FT
});

test("computeColumnStats: orangeCount counts exactly one unresolved leg correctly", () => {
  const matches = [
    { status: "FT", cells: [{ value: "ARS", color: "GREEN" }] },
    { status: "55'", cells: [{ value: "X", color: "ORANGE" }] },
  ];
  const stats = computeColumnStats(headers, matches, betSummary);
  assert.equal(stats[0].orangeCount, 1);
  assert.equal(stats[0].redCount, 0);
});

test("computeColumnStats: a column nobody picked anything in has hasB false, tot 0", () => {
  const matches = [{ status: "FT", cells: [{ value: "", color: "" }, { value: "", color: "" }] }];
  const stats = computeColumnStats(headers, matches, betSummary);
  assert.equal(stats[0].hasB, false);
  assert.equal(stats[0].tot, 0);
});

test("findOneGoalAwayLegs: ORANGE plain pick on a live match is included", () => {
  const matches = [{
    match: "ARS - CHE", homeCode: "ARS", awayCode: "CHE", status: "60'", score: "1-1",
    cells: [{ value: "ARS", color: "ORANGE" }, { value: "", color: "" }],
  }];
  const legs = findOneGoalAwayLegs(headers, matches);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].player, "Snackbar");
  assert.equal(legs[0].pick, "ARS");
});

test("findOneGoalAwayLegs: excludes a pre-kickoff NS match even if ORANGE", () => {
  const matches = [{
    match: "ARS - CHE", homeCode: "ARS", awayCode: "CHE", status: "NS", score: "0-0",
    cells: [{ value: "ARS", color: "ORANGE" }],
  }];
  assert.deepEqual(findOneGoalAwayLegs(headers, matches), []);
});

test("findOneGoalAwayLegs: excludes exact-score/goals-market ORANGE picks, only plain win/draw/away count", () => {
  const matches = [{
    match: "ARS - CHE", homeCode: "ARS", awayCode: "CHE", status: "60'", score: "1-1",
    cells: [{ value: "2-1", color: "ORANGE" }, { value: "Goals 2.5", color: "ORANGE" }],
  }];
  assert.deepEqual(findOneGoalAwayLegs(headers, matches), []);
});

test("findOneGoalAwayLegs: a draw pick at HT counts as live", () => {
  const matches = [{
    match: "ARS - CHE", homeCode: "ARS", awayCode: "CHE", status: "HT", score: "1-0",
    cells: [{ value: "X", color: "ORANGE" }],
  }];
  const legs = findOneGoalAwayLegs(headers, matches);
  assert.equal(legs.length, 1);
  assert.equal(legs[0].pick, "X");
});
