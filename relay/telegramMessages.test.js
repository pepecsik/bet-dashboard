// Run with: node --test relay/telegramMessages.test.js

import test from "node:test";
import assert from "node:assert/strict";
import {
  fmtEUR, formatGoalMessage, formatMatchEndedMessage, formatRedCardMessage, formatDisallowedGoalMessage, formatAllBetsDeadMessage,
  formatBigWinMessage, formatOneMatchAwayMessage,
  formatOneGoalAwayMessage, formatOneGoalAwayAndLastLegMessage, formatBetDiedMessage,
  formatKickoff30MinMessage, formatDayBeforeMessage, formatBetsLockedMessage, formatWeekPointsMessage, whoNeedsToScore,
} from "./telegramMessages.js";

test("fmtEUR formats consistently", () => {
  assert.equal(fmtEUR(47.5), "€47.50");
  assert.equal(fmtEUR(0), "€0.00");
  assert.equal(fmtEUR(null), "€0.00");
});

test("formatGoalMessage leads with the scoring team in caps, score on its own line", () => {
  const msg = formatGoalMessage("Arsenal - Chelsea", "0-0", "1-0");
  assert.equal(msg, "⚽ ARSENAL GOAL!\nArsenal |  1 - 0  | Chelsea");
});

test("formatGoalMessage identifies the away scorer, leading in caps", () => {
  const msg = formatGoalMessage("Arsenal - Chelsea", "0-0", "0-1");
  assert.equal(msg, "⚽ CHELSEA GOAL!\nArsenal |  0 - 1  | Chelsea");
});

test("formatGoalMessage appends the minute after GOAL! when given a live minute", () => {
  const msg = formatGoalMessage("Arsenal - Chelsea", "0-0", "1-0", "58'");
  assert.equal(msg, "⚽ ARSENAL GOAL! (58')\nArsenal |  1 - 0  | Chelsea");
});

test("formatGoalMessage omits the minute when it's not a live minute (FT/HT/NS) or absent", () => {
  assert.equal(formatGoalMessage("Arsenal - Chelsea", "0-0", "1-0", "FT"), "⚽ ARSENAL GOAL!\nArsenal |  1 - 0  | Chelsea");
  assert.equal(formatGoalMessage("Arsenal - Chelsea", "0-0", "1-0"), "⚽ ARSENAL GOAL!\nArsenal |  1 - 0  | Chelsea");
});

test("formatGoalMessage returns null when neither side's count actually went up, or input is malformed", () => {
  assert.equal(formatGoalMessage("Arsenal - Chelsea", "1-1", "1-1"), null);
  assert.equal(formatGoalMessage("Arsenal - Chelsea", "bad", "1-0"), null);
  assert.equal(formatGoalMessage("ArsenalChelsea", "0-0", "1-0"), null); // no " - " separator to split on
});

test("formatMatchEndedMessage includes the match and final score", () => {
  assert.equal(formatMatchEndedMessage("Arsenal - Chelsea", "2-1"), "🏁 FULL TIME: Arsenal - Chelsea 2-1");
  assert.equal(formatMatchEndedMessage("", "2-1"), null);
  assert.equal(formatMatchEndedMessage("Arsenal - Chelsea", ""), null);
});

test("formatRedCardMessage: home side names the home team", () => {
  const msg = formatRedCardMessage("Arsenal - Chelsea", "H", "Declan Rice", "Arsenal", "Chelsea");
  assert.equal(msg, "🟥 ARSENAL RED CARD! — Declan Rice (Arsenal - Chelsea)");
});

test("formatRedCardMessage: away side names the away team", () => {
  const msg = formatRedCardMessage("Arsenal - Chelsea", "A", "Enzo Fernandez", "Arsenal", "Chelsea");
  assert.equal(msg, "🟥 CHELSEA RED CARD! — Enzo Fernandez (Arsenal - Chelsea)");
});

test("formatRedCardMessage: still sends without a player name", () => {
  const msg = formatRedCardMessage("Arsenal - Chelsea", "H", "", "Arsenal", "Chelsea");
  assert.equal(msg, "🟥 ARSENAL RED CARD! (Arsenal - Chelsea)");
});

test("formatDisallowedGoalMessage: real example, Man Utd side", () => {
  const msg = formatDisallowedGoalMessage("Chelsea - Manchester United", "A", "Matheus Cunha", "Chelsea", "Manchester United");
  assert.equal(msg, "🚫 MANCHESTER UNITED GOAL DISALLOWED BY VAR! — Matheus Cunha (Chelsea - Manchester United)");
});

test("formatDisallowedGoalMessage: real example, Chelsea (home) side", () => {
  const msg = formatDisallowedGoalMessage("Chelsea - Manchester United", "H", "Estêvão", "Chelsea", "Manchester United");
  assert.equal(msg, "🚫 CHELSEA GOAL DISALLOWED BY VAR! — Estêvão (Chelsea - Manchester United)");
});

test("formatAllBetsDeadMessage: static wording", () => {
  assert.match(formatAllBetsDeadMessage(), /officially over/);
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

test("formatWeekPointsMessage: regular day uses the running-week header", () => {
  const rows = [{ player: "Snackbar", weekPoints: 4, seasonTotal: 72 }, { player: "Sjaak", weekPoints: 0, seasonTotal: 25 }];
  const msg = formatWeekPointsMessage(rows, false);
  assert.match(msg, /^📊 This week's points:/);
  assert.match(msg, /Snackbar \+4 \(72\)/);
  assert.match(msg, /Sjaak \+0 \(25\)/);
});

test("formatWeekPointsMessage: last day of the week uses the final-score header", () => {
  const rows = [{ player: "Snackbar", weekPoints: 14, seasonTotal: 82 }];
  const msg = formatWeekPointsMessage(rows, true);
  assert.match(msg, /^🏁 Final score this week:/);
});

test("formatWeekPointsMessage: empty rows returns null", () => {
  assert.equal(formatWeekPointsMessage([], false), null);
});
