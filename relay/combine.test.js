// Run with: node --test relay/combine.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { combineState } from "./combine.js";

function makeLastKnown(entries) {
  return new Map(Object.entries(entries).map(([id, v]) => [Number(id), v]));
}

test("combines live score + bets into computed colours (real ARS-CHE cross-check)", () => {
  const betsCache = {
    headers: [{ name: "Snackbar", idx: 3 }, { name: "Timbo", idx: 4 }, { name: "Pepe", idx: 5 }],
    matches: [{
      match: "ARS - CHE", fixtureId: 1557387, homeCode: "ARS", awayCode: "CHE",
      cells: [{ value: "ARS" }, { value: "GOALS 2.5" }, { value: "3-1" }],
    }],
  };
  const lastKnown = makeLastKnown({ 1557387: { status: "46'", score: "2-1", elapsed: 46, match: "ARS - CHE" } });

  const result = combineState(betsCache, lastKnown);
  assert.equal(result.matches.length, 1);
  const m = result.matches[0];
  assert.equal(m.status, "46'");
  assert.equal(m.score, "2-1");
  assert.equal(m.cells[0].color, "GREEN", "ARS home win, already true");
  assert.equal(m.cells[1].color, "GREEN", "3 total goals, over 2.5 hit");
  assert.equal(m.cells[2].color, "ORANGE", "exact score 3-1, one goal off total");
});

test("no live data yet for a match -- treated as NS, nothing wrongly resolved", () => {
  const betsCache = {
    headers: [{ name: "Snackbar", idx: 3 }],
    matches: [{ match: "IPS - LIV", fixtureId: 1557393, homeCode: "IPS", awayCode: "LIV", cells: [{ value: "LIV" }] }],
  };
  const result = combineState(betsCache, new Map()); // relay hasn't seen this fixture live yet
  assert.equal(result.matches[0].status, "NS");
  assert.equal(result.matches[0].score, "");
  // Live-branch logic for an "LIV" (away) pick at 0-0 -- neither ahead nor behind -- orange, not a false red/green.
  assert.equal(result.matches[0].cells[0].color, "ORANGE");
});

test("cards and goalscorer markets are left uncomputed (color: null), not guessed", () => {
  const betsCache = {
    headers: [{ name: "Snackbar", idx: 3 }],
    matches: [{
      match: "ARS - CHE", fixtureId: 1557387, homeCode: "ARS", awayCode: "CHE",
      cells: [{ value: "YELLOW C 3.5" }, { value: "RED C 0.5" }, { value: "SAKA" }, { value: "ARS" }],
    }],
  };
  const lastKnown = makeLastKnown({ 1557387: { status: "FT", score: "2-1", match: "ARS - CHE" } });
  const result = combineState(betsCache, lastKnown);
  const cells = result.matches[0].cells;
  assert.equal(cells[0].color, null, "yellow cards market -- not fetched, left uncomputed");
  assert.equal(cells[1].color, null, "red cards market -- not fetched, left uncomputed");
  assert.equal(cells[2].color, null, "goalscorer guess -- not fetched, left uncomputed");
  assert.equal(cells[3].color, "GREEN", "but a normal team pick in the SAME match still resolves correctly");
});

test("blank bet cell stays blank, not a colour", () => {
  const betsCache = {
    headers: [{ name: "Snackbar", idx: 3 }],
    matches: [{ match: "ARS - CHE", fixtureId: 1557387, homeCode: "ARS", awayCode: "CHE", cells: [{ value: "" }] }],
  };
  const lastKnown = makeLastKnown({ 1557387: { status: "FT", score: "2-1", match: "ARS - CHE" } });
  const result = combineState(betsCache, lastKnown);
  assert.equal(result.matches[0].cells[0].color, "");
});

test("multiple matches, only some live -- each resolved independently", () => {
  const betsCache = {
    headers: [{ name: "Snackbar", idx: 3 }],
    matches: [
      { match: "ARS - CHE", fixtureId: 1557387, homeCode: "ARS", awayCode: "CHE", cells: [{ value: "ARS" }] },
      { match: "IPS - LIV", fixtureId: 1557393, homeCode: "IPS", awayCode: "LIV", cells: [{ value: "IPS" }] },
    ],
  };
  const lastKnown = makeLastKnown({ 1557387: { status: "FT", score: "2-1", match: "ARS - CHE" } });
  const result = combineState(betsCache, lastKnown);
  assert.equal(result.matches[0].status, "FT");
  assert.equal(result.matches[0].cells[0].color, "GREEN");
  assert.equal(result.matches[1].status, "NS", "no live entry for this fixture -- stays NS");
});
