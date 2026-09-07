// Run with: node --test relay/pollGate.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { shouldPollNow } from "./pollGate.js";

const NOW = new Date("2026-09-05T15:00:00Z").getTime();

test("fails open with no matches known yet", () => {
  assert.equal(shouldPollNow([], new Map(), NOW), true);
  assert.equal(shouldPollNow(null, new Map(), NOW), true);
});

test("fails open (keeps old always-poll behaviour) when no match has a kickoff time -- e.g. before Code.gs is updated", () => {
  const matches = [{ fixtureId: 1 }, { fixtureId: 2 }];
  assert.equal(shouldPollNow(matches, new Map(), NOW), true);
});

test("does not poll for a match kicking off well in the future", () => {
  const matches = [{ fixtureId: 1, kickoffTs: NOW + 60 * 60 * 1000 }]; // 1h away
  assert.equal(shouldPollNow(matches, new Map(), NOW), false);
});

test("polls once a match is within 10 minutes of kickoff", () => {
  const matches = [{ fixtureId: 1, kickoffTs: NOW + 9 * 60 * 1000 }];
  assert.equal(shouldPollNow(matches, new Map(), NOW), true);
});

test("keeps polling a match that has kicked off and isn't confirmed FT", () => {
  const matches = [{ fixtureId: 1, kickoffTs: NOW - 90 * 60 * 1000 }]; // kicked off 90 min ago
  const lastKnown = new Map([[1, { status: "90'" }]]);
  assert.equal(shouldPollNow(matches, lastKnown, NOW), true);
});

test("self-terminating: keeps polling however long extra time + penalties takes, no fixed ceiling", () => {
  const matches = [{ fixtureId: 1, kickoffTs: NOW - 155 * 60 * 1000 }]; // 2h35m ago -- well past normal + ET + pens
  const lastKnown = new Map([[1, { status: "PEN" }]]);
  assert.equal(shouldPollNow(matches, lastKnown, NOW), true);
});

test("stops once a match is confirmed FT", () => {
  const matches = [{ fixtureId: 1, kickoffTs: NOW - 120 * 60 * 1000 }];
  const lastKnown = new Map([[1, { status: "FT" }]]);
  assert.equal(shouldPollNow(matches, lastKnown, NOW), false);
});

test("one still-live match among several finished ones is enough to keep polling", () => {
  const matches = [
    { fixtureId: 1, kickoffTs: NOW - 180 * 60 * 1000 },
    { fixtureId: 2, kickoffTs: NOW - 60 * 60 * 1000 },
  ];
  const lastKnown = new Map([
    [1, { status: "FT" }],
    [2, { status: "60'" }],
  ]);
  assert.equal(shouldPollNow(matches, lastKnown, NOW), true);
});

test("a fixtureId with no lastKnown entry at all (never seen live) still counts as unconfirmed, not FT", () => {
  const matches = [{ fixtureId: 1, kickoffTs: NOW - 5 * 60 * 1000 }]; // kicked off 5 min ago
  assert.equal(shouldPollNow(matches, new Map(), NOW), true);
});
