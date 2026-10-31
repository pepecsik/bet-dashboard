// Run with: node --test relay/telegramMessages.test.js

import test from "node:test";
import assert from "node:assert/strict";
import {
  fmtEUR, formatGoalMessage, formatBigWinMessage, formatOneMatchAwayMessage,
  formatOneGoalAwayMessage, formatOneGoalAwayAndLastLegMessage, formatBetDiedMessage,
  formatKickoff30MinMessage, formatDayBeforeMessage, formatBetsLockedMessage, whoNeedsToScore,
} from "./telegramMessages.js";

test("fmtEUR formats consistently", () => {
  assert.equal(fmtEUR(47.5), "€47.50");
  assert.equal(fmtEUR(0), "€0.00");
  assert.equal(fmtEUR(null), "€0.00");
});

test("formatGoalMessage identifies the home scorer", () => {
  const msg = formatGoalMessage("Arsenal - Chelsea", "0-0", "1-0");
  assert.equal(msg, "⚽ GOAL! Arsenal - Chelsea is now 1-0 (Arsenal)");
});

test("formatGoalMessage identifies the away scorer", () => {
  const msg = formatGoalMessage("Arsenal - Chelsea", "0-0", "0-1");
  assert.equal(msg, "⚽ GOAL! Arsenal - Chelsea is now 0-1 (Chelsea)");
});

test("formatGoalMessage returns null when neither side's count actually went up, or input is malformed", () => {
  assert.equal(formatGoalMessage("Arsenal - Chelsea", "1-1", "1-1"), null);
  assert.equal(formatGoalMessage("Arsenal - Chelsea", "bad", "1-0"), null);
  assert.equal(formatGoalMessage("ArsenalChelsea", "0-0", "1-0"), null); // no " - " separator to split on
});

test("formatBigWinMessage is loud, includes player and amount", () => {
  const msg = formatBigWinMessage("Pepe", 47.52);
  assert.match(msg, /FULL WIN/);
  assert.match(msg, /Pepe/);
  assert.match(msg, /€47\.52/);
});

test("formatOneMatchAwayMessage includes the match", () => {
  const msg = formatOneMatchAwayMessage("Pepe", 47.52, "ARS - CHE");
  assert.match(msg, /one match away/);
  assert.match(msg, /ARS - CHE/);
});

test("whoNeedsToScore: team-win pick needs that team", () => {
  assert.equal(whoNeedsToScore("ARS", "ARS", "CHE", "0-0"), "Arsenal");
  assert.equal(whoNeedsToScore("CHE", "ARS", "CHE", "0-0"), "Chelsea");
});

test("whoNeedsToScore: draw pick needs whichever side is trailing", () => {
  assert.equal(whoNeedsToScore("X", "ARS", "CHE", "1-0"), "Chelsea"); // away trailing
  assert.equal(whoNeedsToScore("X", "ARS", "CHE", "0-1"), "Arsenal"); // home trailing
});

test("formatOneGoalAwayMessage: team pick", () => {
  const msg = formatOneGoalAwayMessage("Pepe", "ARS - CHE", "ARS", "CHE", "ARS", "0-0", "55");
  assert.equal(msg, "⚡ Pepe is one goal away in ARS - CHE (0-0, 55') — needs Arsenal to score.");
});

test("formatOneGoalAwayMessage: draw pick, trailing side named correctly", () => {
  const msg = formatOneGoalAwayMessage("Pepe", "ARS - CHE", "ARS", "CHE", "X", "1-0", "70");
  assert.match(msg, /needs Chelsea to score/);
});

test("formatOneGoalAwayAndLastLegMessage: merged wording", () => {
  const msg = formatOneGoalAwayAndLastLegMessage("Pepe", 47.52, "ARS - CHE", "ARS", "CHE", "ARS", "0-0", "80");
  assert.match(msg, /ONE GOAL away from a full win/);
  assert.match(msg, /€47\.52/);
  assert.match(msg, /Arsenal scores in ARS - CHE/);
});

test("formatBetDiedMessage: single death", () => {
  const msg = formatBetDiedMessage([{ player: "Pepe", match: "ARS - CHE", finalScore: "2-1" }]);
  assert.equal(msg, "💀 RIP Pepe's bet. ARS - CHE (final: 2-1) just put it in the ground.");
});

test("formatBetDiedMessage: batches multiple deaths into one message", () => {
  const msg = formatBetDiedMessage([
    { player: "Pepe", match: "ARS - CHE", finalScore: "2-1" },
    { player: "Timbo", match: "LIV - MCI", finalScore: "0-3" },
  ]);
  assert.match(msg, /Bets just died this round/);
  assert.match(msg, /Pepe's bet — ARS - CHE \(final: 2-1\)/);
  assert.match(msg, /Timbo's bet — LIV - MCI \(final: 0-3\)/);
});

test("formatBetDiedMessage: empty list returns null", () => {
  assert.equal(formatBetDiedMessage([]), null);
  assert.equal(formatBetDiedMessage(null), null);
});

test("formatKickoff30MinMessage: groups multiple simultaneous kickoffs", () => {
  const msg = formatKickoff30MinMessage([{ match: "ARS - CHE", time: "15:00" }, { match: "TOT - WHA", time: "15:00" }]);
  assert.match(msg, /starting in 30 min/);
  assert.match(msg, /ARS - CHE \(15:00\)/);
  assert.match(msg, /TOT - WHA \(15:00\)/);
});

test("formatDayBeforeMessage: static reminder text", () => {
  assert.match(formatDayBeforeMessage(), /tomorrow/);
});

test("formatBetsLockedMessage: includes win line only when there's a real highest win", () => {
  const withWin = formatBetsLockedMessage("Friday", "20:00", 47.52, 11.88);
  assert.match(withWin, /Bets locked/);
  assert.match(withWin, /Highest possible win/);
  assert.match(withWin, /€47\.52/);

  const withoutWin = formatBetsLockedMessage("Friday", "20:00", 0, 0);
  assert.doesNotMatch(withoutWin, /Highest possible win/);
});
