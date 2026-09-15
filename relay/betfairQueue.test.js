// Run with: node --test relay/betfairQueue.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { addRequest, getNext, completeRequest, activePlayers, DEFAULT_CLAIM_TTL_MS } from "./betfairQueue.js";

const NOW = new Date("2026-09-20T15:00:00Z").getTime();

test("addRequest queues a new request, ignores a duplicate for the same player", () => {
  let queue = [];
  queue = addRequest(queue, "Snackbar", NOW);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "pending");

  queue = addRequest(queue, "Snackbar", NOW + 1000); // already pending -- ignored
  assert.equal(queue.length, 1);

  queue = addRequest(queue, "Timbo", NOW + 2000);
  assert.equal(queue.length, 2);
});

test("getNext returns null on an empty queue", () => {
  assert.equal(getNext([], NOW), null);
});

test("getNext claims the oldest pending request and returns it", () => {
  let queue = [];
  queue = addRequest(queue, "Snackbar", NOW);
  queue = addRequest(queue, "Timbo", NOW + 1000);

  const job = getNext(queue, NOW + 2000);
  assert.equal(job.player, "Snackbar"); // oldest first
  assert.equal(job.status, "claimed");
  assert.equal(job.claimedAt, NOW + 2000);
});

test("getNext returns null (busy) while anything is already claimed, even for a different player", () => {
  let queue = [];
  queue = addRequest(queue, "Snackbar", NOW);
  queue = addRequest(queue, "Timbo", NOW + 1000);

  getNext(queue, NOW + 2000); // claims Snackbar's
  const second = getNext(queue, NOW + 3000); // Timbo's is pending, but Snackbar's is still claimed
  assert.equal(second, null);
});

test("a stale claim (past the TTL) expires back to pending and can be reclaimed", () => {
  let queue = [];
  queue = addRequest(queue, "Snackbar", NOW);
  const claimed = getNext(queue, NOW + 1000);
  assert.equal(claimed.player, "Snackbar");

  // Still within TTL -- stays busy.
  assert.equal(getNext(queue, NOW + 1000 + DEFAULT_CLAIM_TTL_MS - 1), null);

  // Past TTL -- the stale claim expires, so this same request becomes
  // claimable again (e.g. acca crashed or the Mac slept through the run).
  const reclaimed = getNext(queue, NOW + 1000 + DEFAULT_CLAIM_TTL_MS + 1);
  assert.equal(reclaimed.player, "Snackbar");
  assert.equal(reclaimed.status, "claimed");
});

test("completeRequest removes the player's request so it stops blocking the queue", () => {
  let queue = [];
  queue = addRequest(queue, "Snackbar", NOW);
  queue = addRequest(queue, "Timbo", NOW + 1000);
  getNext(queue, NOW + 2000); // claims Snackbar's

  queue = completeRequest(queue, "Snackbar");
  assert.equal(queue.length, 1);
  assert.equal(queue[0].player, "Timbo");

  // Timbo's is now claimable since nothing else is claimed anymore.
  const job = getNext(queue, NOW + 3000);
  assert.equal(job.player, "Timbo");
});

test("completeRequest is a safe no-op if there's nothing to complete", () => {
  let queue = addRequest([], "Snackbar", NOW);
  queue = completeRequest(queue, "Someone Else");
  assert.equal(queue.length, 1);
});

test("activePlayers lists everyone with a pending or claimed request, not stale-expired ones", () => {
  let queue = [];
  queue = addRequest(queue, "Snackbar", NOW);
  queue = addRequest(queue, "Timbo", NOW + 1000);
  getNext(queue, NOW + 2000); // claims Snackbar's

  assert.deepEqual(activePlayers(queue, NOW + 3000).sort(), ["Snackbar", "Timbo"]);

  queue = completeRequest(queue, "Snackbar");
  assert.deepEqual(activePlayers(queue, NOW + 4000), ["Timbo"]);
});
