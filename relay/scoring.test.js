// Run with: node --test relay/scoring.test.js
//
// Validates the ported formula (scoring.js) against the sheet's own logic
// before it's trusted to decide anything live. The ARS-CHE cases below are
// taken directly from the real dashboard, screenshotted after the
// away-goals formula bug was fixed -- so those aren't invented expectations,
// they're the sheet's own verified output for that exact match.

import test from "node:test";
import assert from "node:assert/strict";
import { scoreBet } from "./scoring.js";

const base = { homeGoals: 2, awayGoals: 1, status: "46'", homeCode: "ARS", awayCode: "CHE" };

test("real match cross-check: ARS 2-1 CHE, still live (46')", () => {
  assert.equal(scoreBet({ ...base, bet: "ARS" }), "GREEN");   // home win, already true
  assert.equal(scoreBet({ ...base, bet: "X" }), "ORANGE");     // draw pick, off by 1 goal
  assert.equal(scoreBet({ ...base, bet: "CHE" }), "RED");      // away win, already false
  assert.equal(scoreBet({ ...base, bet: "GOALS 2.5" }), "GREEN"); // 3 total goals, over 2.5 hit
  assert.equal(scoreBet({ ...base, bet: "3-1" }), "ORANGE");   // exact score, 1 goal off total
});

test("real match cross-check: same final score, but FT now", () => {
  const ft = { ...base, status: "FT" };
  assert.equal(scoreBet({ ...ft, bet: "ARS" }), "GREEN");
  assert.equal(scoreBet({ ...ft, bet: "X" }), "RED");          // FT is binary -- no more near-misses
  assert.equal(scoreBet({ ...ft, bet: "CHE" }), "RED");
  assert.equal(scoreBet({ ...ft, bet: "GOALS 2.5" }), "GREEN");
  assert.equal(scoreBet({ ...ft, bet: "3-1" }), "RED");        // wrong forever once FT, even though "close"
});

test("exact score bet -- live", () => {
  // "Orange" means exactly 1 more goal, anywhere, completes the guess --
  // it's a TOTAL remaining-goals count, not "each side is close".
  const live = { homeGoals: 1, awayGoals: 0, status: "60'", homeCode: "ARS", awayCode: "CHE" };
  assert.equal(scoreBet({ ...live, bet: "1-0" }), "GREEN", "exact match right now -> green even while live");
  assert.equal(scoreBet({ ...live, bet: "2-0" }), "ORANGE", "home needs exactly 1 more, away already matches -> orange");
  assert.equal(scoreBet({ ...live, bet: "1-1" }), "ORANGE", "home already matches, away needs exactly 1 more -> orange");
  assert.equal(scoreBet({ ...live, bet: "2-1" }), "RED", "2 goals still needed in total -> too far, red");
  assert.equal(scoreBet({ ...live, bet: "3-1" }), "RED", "3 goals still needed in total -> red");
  assert.equal(scoreBet({ ...live, bet: "0-0" }), "GRAY", "actual home goals already exceed the guess -> busted, dead immediately even though still live");
  assert.equal(scoreBet({ ...live, bet: "0-1" }), "GRAY", "actual home goals already exceed the guess -> busted, dead immediately even though still live");
});

test("exact score bet -- full time", () => {
  const ft = { homeGoals: 1, awayGoals: 0, status: "FT", homeCode: "ARS", awayCode: "CHE" };
  assert.equal(scoreBet({ ...ft, bet: "1-0" }), "GREEN");
  assert.equal(scoreBet({ ...ft, bet: "2-0" }), "RED", "no orange once FT -- pure win/lose");
});

test("goalscorer bet", () => {
  const live = { homeGoals: 1, awayGoals: 0, status: "60'", scorers: "SAKA", homeCode: "ARS", awayCode: "CHE" };
  assert.equal(scoreBet({ ...live, bet: "SAKA" }), "GREEN", "already scored -- green even while live");
  assert.equal(scoreBet({ ...live, bet: "HAVERTZ" }), "ORANGE", "hasn't scored yet, match still live -- still alive");
  const ft = { ...live, status: "FT" };
  assert.equal(scoreBet({ ...ft, bet: "SAKA" }), "GREEN");
  assert.equal(scoreBet({ ...ft, bet: "HAVERTZ" }), "RED", "match over, never scored -- red");
});

test("goals over/under market", () => {
  const live = (tg) => ({ homeGoals: Math.floor(tg / 2), awayGoals: Math.ceil(tg / 2), status: "60'", homeCode: "ARS", awayCode: "CHE" });
  assert.equal(scoreBet({ ...live(3), bet: "GOALS 2.5" }), "GREEN", "3 goals already, over 2.5 needs 3 -- hit");
  assert.equal(scoreBet({ ...live(2), bet: "GOALS 2.5" }), "ORANGE", "2 goals so far, one more needed -- still alive");
  assert.equal(scoreBet({ ...live(1), bet: "GOALS 2.5" }), "RED", "1 goal so far, two more needed -- too far, red");
  const ft2 = { ...live(2), status: "FT" };
  assert.equal(scoreBet({ ...ft2, bet: "GOALS 2.5" }), "RED", "match over on 2 goals, needed 3 -- red");
});

test("yellow/red card markets", () => {
  const liveYC = { homeGoals: 0, awayGoals: 0, status: "60'", yellowCards: 3, homeCode: "ARS", awayCode: "CHE" };
  assert.equal(scoreBet({ ...liveYC, bet: "YELLOW C 3.5" }), "ORANGE", "3 so far, needs 4 -- one away, still alive");
  assert.equal(scoreBet({ ...liveYC, bet: "YELLOW C 2.5" }), "GREEN", "3 already clears the 2.5 line");
  const liveRC = { homeGoals: 0, awayGoals: 0, status: "60'", redCards: 1, homeCode: "ARS", awayCode: "CHE" };
  assert.equal(scoreBet({ ...liveRC, bet: "RED C 1.5" }), "ORANGE", "1 so far, needs 2 -- one away, still alive");
});

test("draw pick", () => {
  const live = { status: "60'", homeCode: "ARS", awayCode: "CHE" };
  assert.equal(scoreBet({ ...live, homeGoals: 1, awayGoals: 1, bet: "X" }), "GREEN");
  assert.equal(scoreBet({ ...live, homeGoals: 2, awayGoals: 1, bet: "X" }), "ORANGE");
  assert.equal(scoreBet({ ...live, homeGoals: 3, awayGoals: 1, bet: "X" }), "RED");
  const ft = { ...live, status: "FT" };
  assert.equal(scoreBet({ ...ft, homeGoals: 2, awayGoals: 1, bet: "X" }), "RED", "no orange once FT");
});

test("home/away win picks", () => {
  const live = { status: "60'", homeCode: "ARS", awayCode: "CHE" };
  assert.equal(scoreBet({ ...live, homeGoals: 2, awayGoals: 0, bet: "ARS" }), "GREEN");
  assert.equal(scoreBet({ ...live, homeGoals: 1, awayGoals: 1, bet: "ARS" }), "ORANGE");
  assert.equal(scoreBet({ ...live, homeGoals: 0, awayGoals: 1, bet: "ARS" }), "RED");
  assert.equal(scoreBet({ ...live, homeGoals: 0, awayGoals: 2, bet: "CHE" }), "GREEN");
  assert.equal(scoreBet({ ...live, homeGoals: 1, awayGoals: 1, bet: "CHE" }), "ORANGE");
  assert.equal(scoreBet({ ...live, homeGoals: 1, awayGoals: 0, bet: "CHE" }), "RED");
});

test("edge cases", () => {
  assert.equal(scoreBet({ bet: "", homeGoals: 1, awayGoals: 0, status: "FT" }), "", "no bet placed -- blank, not a colour");
  assert.equal(scoreBet({ bet: "  ars  ", homeGoals: 1, awayGoals: 0, status: "FT", homeCode: "ARS", awayCode: "CHE" }), "GREEN", "case/whitespace insensitive, matching TRIM/UPPER in the sheet");
});
