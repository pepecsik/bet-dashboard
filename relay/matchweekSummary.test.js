// Run with: node --test relay/matchweekSummary.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { computeWeeklySummary, SB_PLAYERS } from "./matchweekSummary.js";

function baseData() {
  return {
    headers: [{ name: "Snackbar" }, { name: "Timbo" }],
    matches: [
      {
        match: "ARS - CHE",
        status: "FT",
        scoreboardCells: {
          Snackbar: [{ value: "ARS", color: "#7cff5b" }], // correct, not a score pick -> 1pt
          Timbo: [{ value: "2-1", color: "#ff4d4d" }], // wrong -> 0pt
        },
        cells: [{ value: "ARS", color: "#7cff5b" }, { value: "2-1", color: "#ff4d4d" }],
      },
      {
        match: "LIV - MCI",
        status: "FT",
        scoreboardCells: {
          Snackbar: [{ value: "2-1", color: "#7cff5b" }], // correct score pick -> 3pts
          Timbo: [],
        },
        cells: [{ value: "2-1", color: "#7cff5b" }, { value: "", color: null }],
      },
    ],
    betSummary: [null, { cells: [{ value: 25.5 }, { value: 0 }] }],
  };
}

test("computeWeeklySummary starts every known player at zero", () => {
  const summary = computeWeeklySummary({ matches: [], headers: [] });
  SB_PLAYERS.forEach((p) => assert.deepEqual(summary[p], { points: 0, money: 0 }));
});

test("computeWeeklySummary: points -- 1 for a correct pick, 3 for a correct exact score", () => {
  const summary = computeWeeklySummary(baseData());
  assert.equal(summary.Snackbar.points, 1 + 3);
  assert.equal(summary.Timbo.points, 0);
});

test("computeWeeklySummary: ignores matches that aren't FT yet", () => {
  const data = baseData();
  data.matches[1].status = "63'";
  const summary = computeWeeklySummary(data);
  assert.equal(summary.Snackbar.points, 1); // only the first (FT) match counts
});

test("computeWeeklySummary: money only credited once the whole column is green and every match is FT", () => {
  const summary = computeWeeklySummary(baseData());
  assert.equal(summary.Snackbar.money, 25.5); // both legs green, both FT
  assert.equal(summary.Timbo.money, 0); // has a red leg
});

test("computeWeeklySummary: money withheld while any leg in the column is still pending", () => {
  const data = baseData();
  data.matches[1].status = "63'"; // Snackbar's second leg no longer FT
  const summary = computeWeeklySummary(data);
  assert.equal(summary.Snackbar.money, 0);
});

test("computeWeeklySummary: a header for someone outside SB_PLAYERS is ignored without throwing", () => {
  const data = baseData();
  data.headers.push({ name: "SpecialBetGuy" });
  assert.doesNotThrow(() => computeWeeklySummary(data));
});
