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
function markAwaitingConfirmation(queue, player) {
  const entry = queue.find((r) => r.player === player && r.status === "claimed");
  if (!entry) return queue;
  entry.status = "awaiting_confirmation";
  return queue;
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

export { addRequest, getNext, completeRequest, activePlayers, expireStaleClaims, markAwaitingConfirmation, DEFAULT_CLAIM_TTL_MS };
