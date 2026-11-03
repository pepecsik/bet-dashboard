// Run with: node --test relay/parseStats.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { parseTeamStats, parseLiveStats, parseScorers, parseRedCards, parseDisallowedGoals } from "./parseStats.js";

test("parseTeamStats maps API-Football's type strings to short field names", () => {
  const raw = [
    { type: "Ball Possession", value: "62%" },
    { type: "Expected goals", value: 1.8 },
    { type: "Total Shots", value: 9 },
    { type: "Shots on Goal", value: 4 },
    { type: "Goalkeeper Saves", value: 2 },
    { type: "Fouls", value: 7 },
    { type: "Corner Kicks", value: 5 },
    { type: "Red Cards", value: 1 },
  ];
  assert.deepEqual(parseTeamStats(raw), {
    possession: 62, xg: 1.8, shots_total: 9, shots_on: 4,
    saves: 2, fouls: 7, corners: 5, red: 1,
  });
});

test("parseTeamStats treats a null value as 0, not a missing key", () => {
  const raw = [{ type: "Red Cards", value: null }];
  assert.equal(parseTeamStats(raw).red, 0);
});

test("parseTeamStats returns an empty object for no data", () => {
  assert.deepEqual(parseTeamStats(null), {});
  assert.deepEqual(parseTeamStats(undefined), {});
});

test("parseLiveStats returns null when the response has no statistics -- not a zeroed object", () => {
  assert.equal(parseLiveStats(null), null);
  assert.equal(parseLiveStats([]), null);
  assert.equal(parseLiveStats([{ statistics: [] }]), null); // only one side present
});

test("parseLiveStats maps home/away into the same h_*/a_* shape buildDashboard() already produces", () => {
  const raw = [
    { team: { id: 1 }, statistics: [{ type: "Ball Possession", value: "55%" }, { type: "Corner Kicks", value: 3 }] },
    { team: { id: 2 }, statistics: [{ type: "Ball Possession", value: "45%" }, { type: "Shots on Goal", value: 2 }] },
  ];
  const out = parseLiveStats(raw);
  assert.equal(out.h_poss, 55);
  assert.equal(out.a_poss, 45);
  assert.equal(out.h_corners, 3);
  assert.equal(out.a_shots, 2);
  // Fields with no matching event in the sample default sensibly, same as Code.gs's own || fallback.
  assert.equal(out.h_shots, 0);
  assert.equal(out.a_corners, 0);
});

test("parseScorers formats goals as \"(H)/(A) Player Name\", comma-joined", () => {
  const events = [
    { type: "Goal", team: { id: 10 }, player: { name: "Saka" } },
    { type: "Card", team: { id: 10 }, player: { name: "Someone" } }, // not a goal -- excluded
    { type: "Goal", team: { id: 20 }, player: { name: "Haaland" } },
  ];
  assert.equal(parseScorers(events, 10), "(H) Saka, (A) Haaland");
});

test("parseScorers returns an empty string for no events", () => {
  assert.equal(parseScorers(null, 10), "");
  assert.equal(parseScorers([], 10), "");
});

test("parseRedCards catches both a straight red and a second yellow, excludes a plain yellow/goal", () => {
  const events = [
    { type: "Card", detail: "Red Card", team: { id: 10 }, player: { name: "Declan Rice" } },
    { type: "Card", detail: "Yellow Card", team: { id: 10 }, player: { name: "Someone Else" } }, // not a sending-off -- excluded
    { type: "Card", detail: "Second Yellow card", team: { id: 20 }, player: { name: "Enzo Fernandez" } },
    { type: "Goal", team: { id: 20 }, player: { name: "Haaland" } }, // not a card -- excluded
  ];
  assert.equal(parseRedCards(events, 10), "(H) Declan Rice, (A) Enzo Fernandez");
});

test("parseRedCards returns an empty string for no events", () => {
  assert.equal(parseRedCards(null, 10), "");
  assert.equal(parseRedCards([], 10), "");
});

// Real event shapes confirmed live (2026-11-03) against the Chelsea - Man
// Utd fixture from 2026-10-31, which had two genuine VAR-cancelled goals
// plus an unrelated VAR-confirmed penalty on the same fixture.
test("parseDisallowedGoals catches a real Var/\"Goal cancelled\" event, excludes an unrelated Var event", () => {
  const events = [
    { time: { elapsed: 34, extra: null }, team: { id: 33, name: "Manchester United" }, player: { id: 1165, name: "Matheus Cunha" }, assist: { id: null, name: null }, type: "Var", detail: "Goal cancelled", comments: null },
    { time: { elapsed: 61, extra: null }, team: { id: 49, name: "Chelsea" }, player: { id: 1, name: "Cole Palmer" }, assist: { id: null, name: null }, type: "Var", detail: "Penalty confirmed", comments: null }, // real VAR event, NOT a disallowed goal -- must be excluded
    { time: { elapsed: 71, extra: null }, team: { id: 49, name: "Chelsea" }, player: { id: 425733, name: "Estêvão Willian Almeida de Oliveira Gonçalves" }, assist: { id: null, name: null }, type: "Var", detail: "Goal cancelled", comments: null },
  ];
  assert.equal(parseDisallowedGoals(events, 33), "(H) Matheus Cunha, (A) Estêvão Willian Almeida de Oliveira Gonçalves");
});

test("parseDisallowedGoals excludes a Goal-type event and a Card-type event", () => {
  const events = [
    { type: "Goal", team: { id: 33 }, player: { name: "Someone" } },
    { type: "Card", detail: "Red Card", team: { id: 33 }, player: { name: "Someone Else" } },
  ];
  assert.equal(parseDisallowedGoals(events, 33), "");
});

test("parseDisallowedGoals returns an empty string for no events", () => {
  assert.equal(parseDisallowedGoals(null, 10), "");
  assert.equal(parseDisallowedGoals([], 10), "");
});
