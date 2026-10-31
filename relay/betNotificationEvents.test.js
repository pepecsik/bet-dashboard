// Run with: node --test relay/betNotificationEvents.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { detectBetEvents, emptyNotifiedState } from "./betNotificationEvents.js";

const headers = [{ name: "Pepe" }, { name: "Timbo" }];
const betSummary = [null, { cells: [{ value: 47.52 }, { value: 30 }] }];

test("bigWin fires once when a column goes fully green, not again next tick", () => {
  // Timbo's cell is RED at FT too -- deliberately, to also prove bigWin and
  // deaths fire independently/correctly in the same tick without interfering.
  const matches = [{ match: "ARS - CHE", status: "FT", cells: [{ value: "ARS", color: "GREEN" }, { value: "CHE", color: "RED" }] }];
  const r1 = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  const bigWins = r1.events.filter((e) => e.type === "bigWin");
  assert.equal(bigWins.length, 1);
  assert.deepEqual(bigWins[0], { type: "bigWin", player: "Pepe", amount: 47.52 });
  assert.equal(r1.events.find((e) => e.type === "deaths").entries[0].player, "Timbo");

  const r2 = detectBetEvents(headers, matches, betSummary, r1.notifiedState);
  assert.equal(r2.events.filter((e) => e.type === "bigWin").length, 0); // guarded, no repeat
});

test("bigWin guard resets once the column is cleared (hasB false) for a new matchweek", () => {
  const matches = [{ match: "ARS - CHE", status: "FT", cells: [{ value: "ARS", color: "GREEN" }] }];
  const r1 = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  assert.equal(r1.events.filter((e) => e.type === "bigWin").length, 1);

  const cleared = [{ match: "ARS - CHE", status: "NS", cells: [{ value: "", color: "" }] }];
  const r2 = detectBetEvents(headers, cleared, betSummary, r1.notifiedState);

  const newMatches = [{ match: "LIV - MCI", status: "FT", cells: [{ value: "LIV", color: "GREEN" }] }];
  const r3 = detectBetEvents(headers, newMatches, betSummary, r2.notifiedState);
  assert.equal(r3.events.filter((e) => e.type === "bigWin").length, 1); // fires again next week
});

test("oneMatchAway fires when exactly one leg remains (not live/not a plain pick) -- plain, not merged", () => {
  const matches = [
    { match: "ARS - CHE", status: "FT", homeCode: "ARS", awayCode: "CHE", cells: [{ value: "ARS", color: "GREEN" }] },
    { match: "LIV - MCI", status: "NS", homeCode: "LIV", awayCode: "MCI", cells: [{ value: "2-1", color: "ORANGE" }] }, // exact-score pick, excluded from oneGoalAway
  ];
  const r = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  const evt = r.events.find((e) => e.player === "Pepe");
  assert.equal(evt.type, "oneMatchAway");
  assert.equal(evt.match, "LIV - MCI");
});

test("merge rule: oneMatchAway + live plain-pick one-goal-away on the SAME leg -> single merged event", () => {
  const matches = [
    { match: "ARS - CHE", status: "FT", homeCode: "ARS", awayCode: "CHE", cells: [{ value: "ARS", color: "GREEN" }] },
    { match: "LIV - MCI", status: "60'", homeCode: "LIV", awayCode: "MCI", score: "1-1", cells: [{ value: "LIV", color: "ORANGE" }] },
  ];
  const r = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  const pepeEvents = r.events.filter((e) => e.player === "Pepe");
  assert.equal(pepeEvents.length, 1); // one merged event, not two
  assert.equal(pepeEvents[0].type, "oneGoalAwayAndLastLeg");
  assert.equal(pepeEvents[0].match, "LIV - MCI");
  assert.equal(pepeEvents[0].amount, 47.52);
});

test("standalone oneGoalAway fires for a live orange leg that is NOT the column's last remaining leg", () => {
  const matches = [
    { match: "ARS - CHE", status: "60'", homeCode: "ARS", awayCode: "CHE", score: "0-0", cells: [{ value: "ARS", color: "ORANGE" }] },
    { match: "LIV - MCI", status: "60'", homeCode: "LIV", awayCode: "MCI", score: "2-2", cells: [{ value: "X", color: "ORANGE" }] },
  ];
  // orangeCount is 2 here, so this column is NOT oneMatchAway-eligible (needs exactly 1) --
  // but each individual orange live plain-pick leg should still fire its own standalone oneGoalAway.
  const r = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  const pepeEvents = r.events.filter((e) => e.player === "Pepe" && e.type === "oneGoalAway");
  assert.equal(pepeEvents.length, 2);
});

test("oneGoalAway is edge-triggered: does not re-fire while still true, DOES re-fire after leaving and re-entering", () => {
  // A second, permanently-RED-but-not-FT leg keeps redCount at 1 throughout,
  // so oneMatchAway/the merge rule never triggers here -- this isolates the
  // standalone oneGoalAway edge-triggering behavior on the ARS - CHE leg.
  const otherLeg = { match: "LIV - MCI", status: "70'", homeCode: "LIV", awayCode: "MCI", score: "0-2", cells: [{ value: "LIV", color: "RED" }] };
  const tied = [{ match: "ARS - CHE", status: "60'", homeCode: "ARS", awayCode: "CHE", score: "0-0", cells: [{ value: "ARS", color: "ORANGE" }] }, otherLeg];

  const r1 = detectBetEvents(headers, tied, betSummary, emptyNotifiedState());
  assert.equal(r1.events.filter((e) => e.type === "oneGoalAway").length, 1);

  // Still tied next tick -- same state, must not re-fire.
  const r2 = detectBetEvents(headers, tied, betSummary, r1.notifiedState);
  assert.equal(r2.events.filter((e) => e.type === "oneGoalAway").length, 0);

  // Now Chelsea scores -- Arsenal pick goes RED (no longer orange), leaves the state.
  const chelseaAhead = [{ match: "ARS - CHE", status: "65'", homeCode: "ARS", awayCode: "CHE", score: "0-1", cells: [{ value: "ARS", color: "RED" }] }, otherLeg];
  const r3 = detectBetEvents(headers, chelseaAhead, betSummary, r2.notifiedState);
  assert.equal(r3.events.filter((e) => e.type === "oneGoalAway").length, 0);

  // Arsenal equalizes -- back to tied/orange -- genuinely re-enters, should re-fire.
  const r4 = detectBetEvents(headers, tied, betSummary, r3.notifiedState);
  assert.equal(r4.events.filter((e) => e.type === "oneGoalAway").length, 1);
});

test("dead fires once per column, batches multiple simultaneous deaths into one event", () => {
  const matches = [
    { match: "ARS - CHE", status: "FT", score: "0-1", cells: [{ value: "ARS", color: "RED" }, { value: "", color: "" }] },
    { match: "LIV - MCI", status: "FT", score: "0-3", cells: [{ value: "", color: "" }, { value: "LIV", color: "RED" }] },
  ];
  const r = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  const deathEvent = r.events.find((e) => e.type === "deaths");
  assert.equal(deathEvent.entries.length, 2);
  assert.deepEqual(deathEvent.entries[0], { player: "Pepe", match: "ARS - CHE", finalScore: "0-1" });
  assert.deepEqual(deathEvent.entries[1], { player: "Timbo", match: "LIV - MCI", finalScore: "0-3" });
});

test("dead via GRAY (impossible exact score) fires even before FT, doesn't wait", () => {
  const matches = [{ match: "ARS - CHE", status: "60'", score: "3-0", cells: [{ value: "2-1", color: "GRAY" }] }];
  const r = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  const deathEvent = r.events.find((e) => e.type === "deaths");
  assert.equal(deathEvent.entries.length, 1);
  assert.equal(deathEvent.entries[0].player, "Pepe");
});

test("a single death (not batched with anyone else) is still wrapped in the deaths event with one entry", () => {
  const matches = [{ match: "ARS - CHE", status: "FT", score: "0-1", cells: [{ value: "ARS", color: "RED" }] }];
  const r = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  const deathEvent = r.events.find((e) => e.type === "deaths");
  assert.equal(deathEvent.entries.length, 1);
});

test("a column nobody picked anything in (hasB false) never fires any event", () => {
  const matches = [{ match: "ARS - CHE", status: "FT", cells: [{ value: "", color: "" }] }];
  const r = detectBetEvents(headers, matches, betSummary, emptyNotifiedState());
  assert.deepEqual(r.events, []);
});
