// Run with: node --test relay/parseStats.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { parseTeamStats, parseLiveStats, parseScorers } from "./parseStats.js";

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
