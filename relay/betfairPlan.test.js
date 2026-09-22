// Run with: node --test relay/betfairPlan.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { buildBetPlan, checkSameMatchConflicts, splitMatch } from "./betfairPlan.js";

test("splitMatch pulls home/away team names out of the 'X vs Y' label", () => {
  assert.deepEqual(splitMatch("Arsenal vs Leeds United"), { homeTeam: "Arsenal", awayTeam: "Leeds United" });
  assert.deepEqual(splitMatch(""), { homeTeam: "", awayTeam: "" });
});

test("buildBetPlan orders all Match Odds legs before any special-market leg", () => {
  const exportedBet = {
    player: "Pepe", stake: 2, legCount: 3,
    legs: [
      { match: "Arsenal vs Leeds United", raw: "2-1", market: "Correct Score", selection: "2-1", needsManualCheck: false },
      { match: "Chelsea vs Brentford", raw: "CHE", market: "Match Odds", selection: "Chelsea", needsManualCheck: false },
      { match: "Spurs vs Villa", raw: "X", market: "Match Odds", selection: "The Draw", needsManualCheck: false },
    ],
  };
  const plan = buildBetPlan(exportedBet);
  assert.equal(plan.player, "Pepe");
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((s) => s.type), ["list-pick", "list-pick", "match-page-pick"]);
  // order within the same leg array is preserved for each group, just
  // regrouped -- Chelsea (2nd in input) then Spurs/Villa (3rd) as list
  // picks, Arsenal/Leeds (1st) pushed after as the one match-page pick.
  assert.equal(plan.steps[0].match, "Chelsea vs Brentford");
  assert.equal(plan.steps[1].match, "Spurs vs Villa");
  assert.equal(plan.steps[2].match, "Arsenal vs Leeds United");
});

test("buildBetPlan derives home/draw/away position from the team names, not a guess", () => {
  const exportedBet = {
    player: "Pepe", stake: 2, legCount: 3,
    legs: [
      { match: "Arsenal vs Leeds United", raw: "ARS", market: "Match Odds", selection: "Arsenal", needsManualCheck: false },
      { match: "Chelsea vs Brentford", raw: "BRE", market: "Match Odds", selection: "Brentford", needsManualCheck: false },
      { match: "Spurs vs Villa", raw: "X", market: "Match Odds", selection: "The Draw", needsManualCheck: false },
    ],
  };
  const plan = buildBetPlan(exportedBet);
  assert.equal(plan.steps.find((s) => s.match === "Arsenal vs Leeds United").position, "home");
  assert.equal(plan.steps.find((s) => s.match === "Chelsea vs Brentford").position, "away");
  assert.equal(plan.steps.find((s) => s.match === "Spurs vs Villa").position, "draw");
});

test("buildBetPlan routes Correct Score to all-markets tab, Over/Under to popular tab", () => {
  const exportedBet = {
    player: "Pepe", stake: 2, legCount: 2,
    legs: [
      { match: "Arsenal vs Leeds United", raw: "2-1", market: "Correct Score", selection: "2-1", needsManualCheck: false },
      { match: "Chelsea vs Brentford", raw: "Goals 2.5", market: "Over/Under 2.5 Goals", selection: "Over 2.5", needsManualCheck: false },
    ],
  };
  const plan = buildBetPlan(exportedBet);
  assert.equal(plan.steps.find((s) => s.market === "Correct Score").tab, "all-markets");
  assert.equal(plan.steps.find((s) => s.market === "Over/Under 2.5 Goals").tab, "popular");
});

test("buildBetPlan skips (not guesses) legs that couldn't be translated upstream", () => {
  const exportedBet = {
    player: "Pepe", stake: 2, legCount: 1,
    legs: [
      { match: "Arsenal vs Leeds United", raw: "Yellow Cards Over 3.5", market: null, selection: null, needsManualCheck: true },
    ],
  };
  const plan = buildBetPlan(exportedBet);
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "could not translate pick");
});

test("buildBetPlan captures matchesNeeded once per distinct match, in first-seen order", () => {
  const exportedBet = {
    player: "Pepe", stake: 2, legCount: 2,
    legs: [
      { match: "Arsenal vs Leeds United", raw: "2-1", market: "Correct Score", selection: "2-1", needsManualCheck: false },
      { match: "Chelsea vs Brentford", raw: "CHE", market: "Match Odds", selection: "Chelsea", needsManualCheck: false },
    ],
  };
  const plan = buildBetPlan(exportedBet);
  assert.equal(plan.matchesNeeded.length, 2);
  assert.deepEqual(plan.matchesNeeded[0], { match: "Arsenal vs Leeds United", homeTeam: "Arsenal", awayTeam: "Leeds United" });
});

test("checkSameMatchConflicts is empty for the normal case (one leg per match)", () => {
  const steps = [
    { match: "Arsenal vs Leeds United" },
    { match: "Chelsea vs Brentford" },
  ];
  assert.deepEqual(checkSameMatchConflicts(steps), []);
});

test("checkSameMatchConflicts flags a match appearing in more than one step", () => {
  const steps = [
    { match: "Arsenal vs Leeds United" },
    { match: "Arsenal vs Leeds United" },
    { match: "Chelsea vs Brentford" },
  ];
  assert.deepEqual(checkSameMatchConflicts(steps), ["Arsenal vs Leeds United"]);
});

test("buildBetPlan flags a Match Odds selection that matches neither team name", () => {
  const exportedBet = {
    player: "Pepe", stake: 2, legCount: 1,
    legs: [
      { match: "Arsenal vs Leeds United", raw: "???", market: "Match Odds", selection: "Not A Real Team", needsManualCheck: false },
    ],
  };
  const plan = buildBetPlan(exportedBet);
  assert.equal(plan.steps.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /matches neither team name/);
});
