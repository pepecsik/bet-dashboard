// Decides whether it's worth calling API-Football right now, instead of
// doing it unconditionally on a fixed timer forever (the old behaviour --
// ~8,640 calls/day, live match or not). Self-terminating rather than a
// fixed ceiling: a match stuck in extra time and penalties just keeps
// polling for as long as it genuinely hasn't reported FT, however long
// that actually takes, rather than guessing a "90 + 30 + pens" cutoff.
//
// Fails OPEN (returns true, i.e. keep polling) whenever it can't tell --
// no matches known yet, or none of them carry a kickoff time. That second
// case matters specifically during the rollout of this feature: until
// Code.gs's buildBetsSnapshot() is updated to send kickoffTs, every match
// looks like "no kickoff info", so this silently behaves exactly like the
// old always-poll behaviour instead of going dark.
function shouldPollNow(matches, lastKnownByFixtureId, now = Date.now()) {
  if (!matches || matches.length === 0) return true;

  const TEN_MIN_MS = 10 * 60 * 1000;
  let anyKickoffInfo = false;

  for (const m of matches) {
    if (!m.kickoffTs) continue;
    const kickoff = new Date(m.kickoffTs).getTime();
    if (Number.isNaN(kickoff)) continue;
    anyKickoffInfo = true;

    const withinPreKickoffWindow = kickoff - now <= TEN_MIN_MS;
    if (!withinPreKickoffWindow) continue; // kicks off later than 10 min from now -- not yet

    const known = m.fixtureId ? lastKnownByFixtureId.get(m.fixtureId) : null;
    const confirmedFT = known && known.status === "FT";
    if (!confirmedFT) return true; // imminent, in progress, or unconfirmed -- poll
  }

  // Every match had a kickoff time and none of them justified polling.
  if (anyKickoffInfo) return false;

  // No match had a kickoff time at all -- can't safely gate, so don't.
  return true;
}

export { shouldPollNow };
