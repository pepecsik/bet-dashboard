// Manages the "place this person's bets on Betfair" request queue -- the
// app calls addRequest() when someone confirms the button, acca's cron
// poll calls getNext() every ~30s, and the report-back call (once built)
// calls completeRequest() once both of that person's bets are placed.
//
// Design per the poll-not-push plan (see acca side's own reply): getNext()
// returns null whenever ANY request is currently claimed-but-not-completed
// -- not just when the queue is empty -- which gives free one-at-a-time
// serialization across players with no lock file needed on acca's side.
// A claim that's gone stale (acca crashed, the Mac was asleep, etc.) auto-
// expires back to pending after claimTtlMs, so a dead run can never jam
// the queue forever.
//
// Pure functions operating on a plain array the caller owns (server.js's
// own module state) -- same pattern as pollGate.js -- so this is testable
// without a live relay or real timers.

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Adds a new pending request for `player`, unless one is already
// pending/claimed for them (avoids piling up duplicate requests if the
// button gets pressed more than once before the first is picked up).
function addRequest(queue, player, now = Date.now(), test = false) {
  const alreadyQueued = queue.some((r) => r.player === player && r.status !== "done");
  if (alreadyQueued) return queue;
  queue.push({ player, status: "pending", requestedAt: now, claimedAt: null, test: !!test });
  return queue;
}

// Expires any claimed request older than claimTtlMs back to pending, in
// place. Separated out so getNext() and status() both see the same
// up-to-date view without duplicating the expiry logic.
//
// Deliberately does NOT touch "awaiting_confirmation" -- see
// markAwaitingConfirmation()'s comment for why that status has no auto-
// expiry at all, unlike a plain claim.
function expireStaleClaims(queue, now = Date.now(), claimTtlMs = DEFAULT_CLAIM_TTL_MS) {
  queue.forEach((r) => {
    if (r.status === "claimed" && now - r.claimedAt > claimTtlMs) {
      r.status = "pending";
      r.claimedAt = null;
    }
  });
  return queue;
}

// Returns the next request to work on, or null if either the queue is
// empty or something else is already claimed/awaiting-confirmation (busy)
// -- global one-at-a-time serialization, no per-player logic needed on the
// caller's side. Mutates the matched entry to "claimed" in place before
// returning it.
function getNext(queue, now = Date.now(), claimTtlMs = DEFAULT_CLAIM_TTL_MS) {
  expireStaleClaims(queue, now, claimTtlMs);
  if (queue.some((r) => r.status === "claimed" || r.status === "awaiting_confirmation")) return null; // busy
  const next = queue.find((r) => r.status === "pending");
  if (!next) return null;
  next.status = "claimed";
  next.claimedAt = now;
  return next;
}

// Marks `player`'s claimed request as paused, waiting on a real per-bet
// Telegram reply before acca can place (or, for a test job, confirm) the
// next bet -- see PLACEMENT_MANUAL.md's Step 5/5a. No-op (returns the
// queue unchanged) if that player doesn't currently have a claimed
// request, e.g. a stale/duplicate call.
//
// Deliberately has NO expiry, unlike a plain claim: by the time a job
// reaches this state, bet 1 may already have been placed for real. Auto-
// recycling it back to "pending" after some timeout -- the way a plain
// stale claim does -- would let it get claimed and rebuilt from scratch,
// risking a genuine duplicate real-money placement. A wait that's
// stuck for real (acca crashed before ever getting Winston's reply, say)
// needs a human to notice and clear it via the normal report-back/complete
// path, not an automatic guess that it's safe to retry.
// `pendingBet` (optional) is the actual bet acca is asking about -- legs,
// stake, combined odds, potential return -- so the admin app can show what's
// being decided, not just a bare "awaiting reply" status. Always resets
// `decision`/`decisionAt` to null, even on a second call for the same
// player (bet 2's ask re-using this same function): a stale decision from
// bet 1 must never carry over and silently auto-approve bet 2.
// `pendingBet` (optional) is the actual bet acca is asking about -- legs,
// stake, combined odds, potential return -- so the admin app can show what's
// being decided, not just a bare "awaiting reply" status. Always resets
// `decision`/`decisionAt` to null, even on a second call for the same
// player (bet 2's ask re-using this same function): a stale decision from
// bet 1 must never carry over and silently auto-approve bet 2.
//
// Also accepts a player already sitting at "awaiting_confirmation", not just
// "claimed" -- on purpose: this is the only way to correct a bet's detail
// after it's already been signaled (e.g. a leg that needed a second search
// attempt to find, arriving after the first, incomplete version was already
// sent). Without this, the only way to fix a mistake was reject-and-restart
// the whole job -- a real gap found live: acca found a missing leg, tried to
// re-signal the corrected bet, and got rejected because the entry was
// already in awaiting_confirmation. Resetting decision on every call (see
// above) already makes this safe even if Winston had approved the earlier,
// wrong version before the correction arrived -- that stale approval is
// wiped, exactly as it should be, since it was approving different data.
function markAwaitingConfirmation(queue, player, pendingBet = null) {
  const entry = queue.find((r) => r.player === player && (r.status === "claimed" || r.status === "awaiting_confirmation"));
  if (!entry) return queue;
  entry.status = "awaiting_confirmation";
  entry.pendingBet = pendingBet;
  entry.decision = null;
  entry.decisionAt = null;
  return queue;
}

// Records the app's decision ("approve" or "reject") for whichever bet is
// currently awaiting confirmation for `player` -- called by the admin
// panel's Approve/Reject buttons. No-op if that player isn't actually
// awaiting confirmation right now (e.g. a stale double-click after the job
// already moved on).
function recordDecision(queue, player, decision, now = Date.now()) {
  const entry = queue.find((r) => r.player === player && r.status === "awaiting_confirmation");
  if (!entry) return queue;
  entry.decision = decision;
  entry.decisionAt = now;
  return queue;
}

// Atomically reads AND clears `player`'s pending decision -- same
// claim-on-read pattern as getNext(), so acca's poll can never double-act on
// the same decision (e.g. clicking Place Bet twice) if it happens to poll
// again before finishing whatever the first read triggered. Returns null if
// there's no decision waiting (not awaiting confirmation at all, or awaiting
// but nobody's decided yet).
//
// Also moves the entry's status back to "claimed" once a real decision is
// taken -- acca is actively handling it again now (placing/confirming, then
// either building the next bet or stopping on reject), the same state it
// was in before markAwaitingConfirmation() paused it. Without this, the
// entry stays stuck at "awaiting_confirmation" with the now-stale pendingBet
// from the bet that just got decided -- markAwaitingConfirmation()'s own
// lookup for the NEXT bet requires status "claimed", so bet 2 would
// wrongly 404 ("no claimed request found") even though the job is very
// much still in progress. Confirmed via a real end-to-end run: Bet 1
// resolved correctly, then Bet 2's awaiting-confirmation call failed with
// exactly this 404 because of this missing transition.
//
// Also refreshes claimedAt to `now` -- without this, the 15-minute
// stale-claim timer (see expireStaleClaims()) would resume counting from
// whenever the job was ORIGINALLY claimed, before the wait for a decision
// even started. A confirmation can easily take longer than 15 minutes
// (that's the whole reason awaiting_confirmation is exempt from the timer
// in the first place), so without this refresh, resuming to "claimed"
// could immediately -- or very soon -- expire a claim that's actually
// still genuinely in progress.
function takeDecision(queue, player, now = Date.now()) {
  const entry = queue.find((r) => r.player === player && r.status === "awaiting_confirmation");
  if (!entry || !entry.decision) return null;
  const decision = entry.decision;
  entry.status = "claimed";
  entry.claimedAt = now;
  entry.decision = null;
  entry.decisionAt = null;
  return decision;
}

// Marks `player`'s request done (removed from the active queue) -- called
// once results have been reported back. No-op if there isn't one (e.g.
// called twice, or the request already expired and was re-claimed under a
// different cycle) rather than throwing.
function completeRequest(queue, player) {
  const idx = queue.findIndex((r) => r.player === player && r.status !== "done");
  if (idx === -1) return queue;
  queue.splice(idx, 1);
  return queue;
}

// Which players currently have an active (pending or claimed) request --
// what the app polls to decide whether to hide an avatar that's mid-flow,
// before the Sheet's own WIN value eventually takes over that job
// permanently once placement actually completes.
function activePlayers(queue, now = Date.now(), claimTtlMs = DEFAULT_CLAIM_TTL_MS) {
  expireStaleClaims(queue, now, claimTtlMs);
  return queue.filter((r) => r.status !== "done").map((r) => r.player);
}

export { addRequest, getNext, completeRequest, activePlayers, expireStaleClaims, markAwaitingConfirmation, recordDecision, takeDecision, DEFAULT_CLAIM_TTL_MS };
