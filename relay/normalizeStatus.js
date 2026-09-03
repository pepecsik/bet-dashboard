// Mirrors Code.gs's normalizeFixtureStatus() exactly. API-Football hands
// back raw short status codes ("1H", "2H", "FT", "AET", "PEN", "NS", "HT",
// ...) -- these need converting to the same display/scoring format the
// rest of the app already expects (minute-formatted while live, a plain
// "FT" once genuinely over -- including extra time and penalties, "NS"
// pre-kickoff) before they're stored or scored. Skipping this meant a live
// match displayed a bare "2H" instead of its actual minute, and a match
// that went to extra time/penalties would never register as finished to
// scoring.js's isFT check (status === "FT").

function normalizeStatus(shortStatus, elapsed) {
  if (["1H", "2H", "ET", "LIVE"].includes(shortStatus)) return `${elapsed}'`;
  if (["FT", "AET", "PEN"].includes(shortStatus)) return "FT";
  if (["NS", "TBD"].includes(shortStatus)) return "NS";
  return shortStatus; // e.g. "HT" -- passes through unchanged, matching Code.gs
}

export { normalizeStatus };
