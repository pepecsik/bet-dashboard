// Run with: node --test relay/betfairQueue.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { addRequest, getNext, completeRequest, activePlayers, markAwaitingConfirmation, recordDecision, takeDecision, DEFAULT_CLAIM_TTL_MS } from "./betfairQueue.js";

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

test("addRequest defaults test to false, and stores true when passed -- carried through by getNext", () => {
  let queue = [];
  queue = addRequest(queue, "Snackbar", NOW);
  assert.equal(queue[0].test, false);

  queue = addRequest(queue, "Timbo", NOW + 1000, true);
  assert.equal(queue[1].test, true);

  const job = getNext(queue, NOW + 2000); // claims Snackbar's (oldest first)
  assert.equal(job.test, false);
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

test("markAwaitingConfirmation moves a claimed request to awaiting_confirmation, and is a no-op for anything else", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  getNext(queue, NOW + 1000); // claims Pepe's
  queue = markAwaitingConfirmation(queue, "Pepe");
  assert.equal(queue[0].status, "awaiting_confirmation");

  // No-op: nothing claimed for Snackbar.
  queue = addRequest(queue, "Snackbar", NOW + 2000);
  queue = markAwaitingConfirmation(queue, "Snackbar");
  assert.equal(queue[1].status, "pending"); // untouched, still pending not awaiting_confirmation

  // No-op: calling it again on an already-awaiting_confirmation entry doesn't error.
  queue = markAwaitingConfirmation(queue, "Pepe");
  assert.equal(queue[0].status, "awaiting_confirmation");
});

test("getNext treats awaiting_confirmation as busy, same as claimed -- blocks the whole queue", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  queue = addRequest(queue, "Timbo", NOW + 1000);
  getNext(queue, NOW + 2000); // claims Pepe's
  queue = markAwaitingConfirmation(queue, "Pepe");

  assert.equal(getNext(queue, NOW + 3000), null); // still busy, even though nothing is "claimed" anymore
  assert.equal(getNext(queue, NOW + 3000 + DEFAULT_CLAIM_TTL_MS * 10), null); // and never times out, unlike a plain claim
});

test("expireStaleClaims never touches an awaiting_confirmation entry, no matter how much time passes", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  getNext(queue, NOW + 1000);
  queue = markAwaitingConfirmation(queue, "Pepe");

  const farFuture = NOW + DEFAULT_CLAIM_TTL_MS * 1000;
  activePlayers(queue, farFuture); // runs expireStaleClaims internally
  assert.equal(queue[0].status, "awaiting_confirmation"); // still paused, not silently recycled back to pending
});

test("completeRequest clears an awaiting_confirmation entry the same as any other active status", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  getNext(queue, NOW + 1000);
  queue = markAwaitingConfirmation(queue, "Pepe");

  queue = completeRequest(queue, "Pepe");
  assert.equal(queue.length, 0);
});

test("markAwaitingConfirmation stores the optional pendingBet detail and resets any stale decision", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  getNext(queue, NOW + 1000);
  const bet1 = { betNumber: 1, legs: [{ match: "ARS v CHE", selection: "ARS" }], stake: 2 };
  queue = markAwaitingConfirmation(queue, "Pepe", bet1);
  assert.deepEqual(queue[0].pendingBet, bet1);
  assert.equal(queue[0].decision, null);

  // Simulate a decision being recorded, then this same function getting
  // called again for bet 2 -- the stale "approve" from bet 1 must not
  // silently carry over and auto-approve bet 2.
  queue = recordDecision(queue, "Pepe", "approve", NOW + 2000);
  assert.equal(queue[0].decision, "approve");
  queue[0].status = "claimed"; // simulate having acted on bet 1 and moved on
  const bet2 = { betNumber: 2, legs: [{ match: "LIV v MCI", selection: "LIV" }], stake: 2 };
  queue = markAwaitingConfirmation(queue, "Pepe", bet2);
  assert.deepEqual(queue[0].pendingBet, bet2);
  assert.equal(queue[0].decision, null, "a stale decision from bet 1 must not survive into bet 2's wait");
});

test("markAwaitingConfirmation can correct an already-awaiting bet, real bug: a leg found on a second search attempt couldn't be re-signaled", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  getNext(queue, NOW + 1000);
  const incomplete = { betNumber: 1, legCount: 6, legs: [{ selection: "ARS" }, { selection: "CHE" }], stake: 2, combinedOdds: "342.67/1", potentialReturn: 687.34 };
  queue = markAwaitingConfirmation(queue, "Pepe", incomplete);
  assert.equal(queue[0].status, "awaiting_confirmation");

  // Winston approves the incomplete version before the correction arrives --
  // this stale approval must be wiped when the corrected data lands, not
  // silently treated as authorization for different figures.
  queue = recordDecision(queue, "Pepe", "approve", NOW + 1500);
  assert.equal(queue[0].decision, "approve");

  // The real scenario: acca finds the missing leg and needs to re-signal
  // while the entry is STILL "awaiting_confirmation", not "claimed" -- this
  // used to be a no-op (entry not found), leaving the stale 5-fold stuck.
  const corrected = { betNumber: 1, legCount: 6, legs: [{ selection: "ARS" }, { selection: "CHE" }, { selection: "Nottm Forest" }], stake: 2, combinedOdds: "554.16/1", potentialReturn: 1110.32 };
  queue = markAwaitingConfirmation(queue, "Pepe", corrected);
  assert.equal(queue[0].status, "awaiting_confirmation", "still awaiting -- the correction doesn't complete the job, it just updates what's pending");
  assert.deepEqual(queue[0].pendingBet, corrected, "the app now shows the corrected 6-fold, not the stale 5-fold");
  assert.equal(queue[0].decision, null, "the earlier approval was for the WRONG data and must not carry over to the corrected bet");
});

test("recordDecision only applies to a player currently awaiting confirmation, and is a safe no-op otherwise", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW); // still just "pending", not awaiting_confirmation
  queue = recordDecision(queue, "Pepe", "approve", NOW + 1000);
  assert.equal(queue[0].decision, undefined, "no-op -- Pepe isn't awaiting confirmation yet");

  queue = recordDecision(queue, "Someone Else", "approve", NOW + 1000);
  assert.equal(queue.length, 1, "no-op for a player with no entry at all -- doesn't throw or add one");
});

test("takeDecision reads and clears atomically -- a second read sees null, not the same decision again", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  getNext(queue, NOW + 1000);
  queue = markAwaitingConfirmation(queue, "Pepe", { betNumber: 1 });

  assert.equal(takeDecision(queue, "Pepe"), null, "nobody's decided yet");

  queue = recordDecision(queue, "Pepe", "reject", NOW + 2000);
  assert.equal(takeDecision(queue, "Pepe"), "reject", "first read gets the real decision");
  assert.equal(takeDecision(queue, "Pepe"), null, "second read is empty -- already consumed, no double-processing");
  assert.equal(queue[0].decision, null);
});

test("takeDecision moves the entry back to claimed and refreshes claimedAt -- real bug: bet 2's markAwaitingConfirmation used to 404", () => {
  let queue = [];
  queue = addRequest(queue, "Pepe", NOW);
  getNext(queue, NOW + 1000); // claimed, claimedAt = NOW + 1000
  const bet1 = { betNumber: 1, legs: [{ selection: "ARS" }], stake: 2 };
  queue = markAwaitingConfirmation(queue, "Pepe", bet1); // status -> awaiting_confirmation

  queue = recordDecision(queue, "Pepe", "approve", NOW + 2000);
  // Simulate a confirmation that took a long time -- well past the 15-minute
  // TTL from the ORIGINAL claim -- to prove claimedAt actually gets refreshed,
  // not just left stale.
  const muchLater = NOW + 1000 + DEFAULT_CLAIM_TTL_MS + 60000;
  const decision = takeDecision(queue, "Pepe", muchLater);
  assert.equal(decision, "approve");
  assert.equal(queue[0].status, "claimed", "back to claimed so the next markAwaitingConfirmation() call can find it");
  assert.equal(queue[0].claimedAt, muchLater, "claimedAt refreshed, not left at the original (now long-expired) claim time");

  // Prove the refresh actually matters: while still in the brief "claimed"
  // window (before bet 2's build even starts), a check using the OLD
  // claimedAt would have looked stale and expired immediately. With the
  // refresh, it correctly stays busy.
  assert.equal(getNext(queue, muchLater + 1000), null, "still busy right after resuming -- not wrongly swept as a stale claim");

  // This is the exact real-world sequence that used to fail: acca resumes
  // after approve, builds bet 2, and signals awaiting-confirmation again.
  const bet2 = { betNumber: 2, legs: [{ selection: "CHE" }], stake: 2 };
  queue = markAwaitingConfirmation(queue, "Pepe", bet2);
  assert.equal(queue[0].status, "awaiting_confirmation", "bet 2's awaiting-confirmation call must succeed, not 404");
  assert.deepEqual(queue[0].pendingBet, bet2, "bet 2's detail replaces bet 1's stale data");
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
