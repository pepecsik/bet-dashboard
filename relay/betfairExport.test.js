// Run with: node --test relay/betfairExport.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { buildBetfairExport, formatBetfairExportText, translatePick, teamName } from "./betfairExport.js";

test("teamName maps a known code, falls back to the raw code for an unknown one", () => {
  assert.equal(teamName("ARS"), "Arsenal");
  assert.equal(teamName("ars"), "Arsenal"); // case-insensitive
  assert.equal(teamName("ZZZ"), "ZZZ");
  assert.equal(teamName(null), null);
});

test("translatePick handles all 3 real bet types, using the real cell-value formats", () => {
  // Real format (confirmed against live test data): a team-win pick is the
  // literal team code, not a generic "1"/"2".
  assert.deepEqual(translatePick("ARS", "ARS", "CHE"), { market: "Match Odds", selection: "Arsenal" });
  assert.deepEqual(translatePick("CHE", "ARS", "CHE"), { market: "Match Odds", selection: "Chelsea" });
  assert.deepEqual(translatePick("X", "ARS", "CHE"), { market: "Match Odds", selection: "The Draw" });
  assert.deepEqual(translatePick("2-1", "ARS", "CHE"), { market: "Correct Score", selection: "2-1" });
  // Real format: "Goals 2.5", not "Over 2.5" -- always an Over pick, no
  // Under variant exists in this product.
  assert.deepEqual(translatePick("Goals 2.5", "ARS", "CHE"), { market: "Over/Under 2.5 Goals", selection: "Over 2.5" });
});

test("translatePick still recognizes 1/2 and Over/Under X.X as a defensive fallback", () => {
  assert.deepEqual(translatePick("1", "ARS", "CHE"), { market: "Match Odds", selection: "Arsenal" });
  assert.deepEqual(translatePick("2", "ARS", "CHE"), { market: "Match Odds", selection: "Chelsea" });
  assert.deepEqual(translatePick("Over 2.5", "ARS", "CHE"), { market: "Over/Under 2.5 Goals", selection: "Over 2.5" });
  assert.deepEqual(translatePick("Under 1.5", "ARS", "CHE"), { market: "Over/Under 1.5 Goals", selection: "Under 1.5" });
});

test("translatePick returns null (never guesses) for blank or unrecognized picks", () => {
  assert.equal(translatePick("", "ARS", "CHE"), null);
  assert.equal(translatePick(null, "ARS", "CHE"), null);
  assert.equal(translatePick("Yellow Cards Over 3.5", "ARS", "CHE"), null); // cards market -- not one of the 3 known types
  assert.equal(translatePick("Messi to score", "ARS", "CHE"), null); // goalscorer guess
});

const betsCache = {
  headers: [{ name: "Snackbar", idx: 3 }, { name: "Snackbar", idx: 4 }, { name: "Timbo", idx: 5 }],
  matches: [
    {
      match: "ARS - CHE", fixtureId: 1, homeCode: "ARS", awayCode: "CHE",
      cells: [{ value: "ARS" }, { value: "2-1" }, { value: "" }], // Timbo hasn't picked this match yet
    },
    {
      match: "LIV - MCI", fixtureId: 2, homeCode: "LIV", awayCode: "CTY",
      cells: [{ value: "X" }, { value: "Goals 2.5" }, { value: "Yellow Cards Over 3.5" }],
    },
  ],
};

test("buildBetfairExport groups legs by column, skipping matches with no pick yet", () => {
  const result = buildBetfairExport(betsCache);
  assert.equal(result.bets.length, 3);

  const snackbarBet1 = result.bets[0];
  assert.equal(snackbarBet1.player, "Snackbar");
  assert.equal(snackbarBet1.sheetColIdx, 3); // the real sheet column, not the array position
  assert.equal(snackbarBet1.stake, 2);
  assert.equal(snackbarBet1.legCount, 2);
  assert.equal(snackbarBet1.legs[0].match, "Arsenal vs Chelsea");
  assert.equal(snackbarBet1.legs[0].market, "Match Odds");
  assert.equal(snackbarBet1.legs[0].selection, "Arsenal");
  assert.equal(snackbarBet1.legs[0].needsManualCheck, false);

  const snackbarBet2 = result.bets[1];
  assert.equal(snackbarBet2.legs[0].selection, "2-1");
  assert.equal(snackbarBet2.legs[1].selection, "Over 2.5");

  const timboBet = result.bets[2];
  // Timbo has no pick at all in match 1 -- that leg is skipped entirely,
  // not shown as blank/wrong.
  assert.equal(timboBet.legCount, 1);
  assert.equal(timboBet.legs[0].match, "Liverpool vs Manchester City");
  assert.equal(timboBet.legs[0].needsManualCheck, true); // cards market -- flagged, not guessed
  assert.equal(timboBet.legs[0].market, null);
});

test("formatBetfairExportText renders a readable recap with unrecognized legs flagged", () => {
  const text = formatBetfairExportText(buildBetfairExport(betsCache));
  assert.match(text, /Bet 1 -- Snackbar -- stake £2\.00 -- 2-leg accumulator/);
  assert.match(text, /Match Odds: back "Arsenal"/);
  assert.match(text, /Correct Score: back "2-1"/);
  assert.match(text, /Over\/Under 2\.5 Goals: back "Over 2\.5"/);
  assert.match(text, /COULD NOT TRANSLATE, check manually/);
});

test("buildBetfairExport handles an empty/missing betsCache without throwing", () => {
  assert.deepEqual(buildBetfairExport({}).bets, []);
  assert.deepEqual(buildBetfairExport({ headers: [], matches: [] }).bets, []);
});
