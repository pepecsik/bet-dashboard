// Translates this week's 6 accumulator bets (one per header/column, each
// covering every tracked match as a leg -- see the user's own description:
// one £2 stake per column, all matches in it need to be right) into
// Betfair's own market/selection wording. This is the structured task
// input an external automation agent (or a human) needs to actually build
// the multiple bet on Betfair's Sportsbook -- Betfair's Exchange API can't
// place this bet type at all (accumulators are a Sportsbook thing, and the
// Sportsbook has no public bet-placement API), so this stays a "tell a
// human/agent exactly what to click" export, not a real Betfair API call.
//
// Pure function of betsCache (same shape server.js already keeps cached
// from Code.gs's ?mode=bets), so it's independently testable without a
// live relay or a live Betfair connection.

// Only the codes Code.gs's own fetchAndWriteFixtures() teamCodes map
// produces (see Code.gs, not in this repo) -- kept in sync here manually.
// Picks one canonical full name per code; Betfair's own exact spelling on
// its markets hasn't been verified against this list yet, so treat it as a
// best-effort starting point to check during the first real run, not a
// guaranteed match.
const TEAM_NAMES = {
  ARS: "Arsenal", AVI: "Aston Villa", BOU: "Bournemouth", BRE: "Brentford",
  BRI: "Brighton & Hove Albion", BUR: "Burnley", CHE: "Chelsea", CPA: "Crystal Palace",
  EVE: "Everton", FUL: "Fulham", LEE: "Leeds United", LIV: "Liverpool",
  CTY: "Manchester City", MAN: "Manchester United", NWC: "Newcastle United",
  NOT: "Nottingham Forest", SUN: "Sunderland", TOT: "Tottenham Hotspur",
  WHA: "West Ham United", WOL: "Wolverhampton Wanderers", LEI: "Leicester City",
  SOU: "Southampton", IPS: "Ipswich Town",
};

function teamName(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  return TEAM_NAMES[c] || c; // unmapped club -- fall back to the raw code rather than hide it
}

// One pick's raw cell value -> a Betfair market + selection, or null if it
// doesn't match one of the 3 bet types actually in use (team/draw win,
// exact score, goals over/under -- see combine.js/scoring.js for the same
// set). Deliberately returns null instead of guessing -- a wrong guess here
// is worse than no answer at all, since this feeds a real-money bet.
function translatePick(rawValue, homeCode, awayCode) {
  const val = String(rawValue || "").trim();
  if (!val) return null;

  const upper = val.toUpperCase();
  if (upper === "1") return { market: "Match Odds", selection: teamName(homeCode) };
  if (upper === "2") return { market: "Match Odds", selection: teamName(awayCode) };
  if (upper === "X") return { market: "Match Odds", selection: "The Draw" };

  const scoreMatch = val.match(/^(\d+)\s*-\s*(\d+)$/);
  if (scoreMatch) return { market: "Correct Score", selection: `${scoreMatch[1]}-${scoreMatch[2]}` };

  const goalsMatch = upper.match(/^(OVER|UNDER)\s*(\d+(?:\.\d+)?)$/);
  if (goalsMatch) {
    const line = goalsMatch[2];
    const verb = goalsMatch[1] === "OVER" ? "Over" : "Under";
    return { market: `Over/Under ${line} Goals`, selection: `${verb} ${line}` };
  }

  return null; // cards / goalscorer / anything else not in the 3 known types
}

// Builds the full weekly export: one entry per header/column (bet slot),
// each with one leg per tracked match that column actually has a pick in
// (a match with no pick yet -- bets not all placed -- is simply skipped for
// that column rather than shown as an empty/wrong leg).
function buildBetfairExport(betsCache) {
  const headers = (betsCache && betsCache.headers) || [];
  const matches = (betsCache && betsCache.matches) || [];

  const bets = headers.map((h, colIdx) => {
    const legs = [];
    matches.forEach((m) => {
      const cell = (m.cells || [])[colIdx];
      if (!cell || !cell.value) return;
      const translated = translatePick(cell.value, m.homeCode, m.awayCode);
      legs.push({
        match: `${teamName(m.homeCode)} vs ${teamName(m.awayCode)}`,
        raw: cell.value,
        market: translated ? translated.market : null,
        selection: translated ? translated.selection : null,
        needsManualCheck: !translated,
      });
    });
    return { player: h.name, stake: 2, legCount: legs.length, legs };
  });

  return { generatedAt: new Date().toISOString(), bets };
}

// Same data, rendered as plain text -- easier to hand to a person or an
// automation agent as a task description than raw JSON, and any leg
// flagged needsManualCheck stands out instead of silently blending in.
function formatBetfairExportText(exportData) {
  const lines = [];
  (exportData.bets || []).forEach((bet, i) => {
    lines.push(`Bet ${i + 1} -- ${bet.player} -- stake £${bet.stake.toFixed(2)} -- ${bet.legCount}-leg accumulator`);
    bet.legs.forEach((leg, li) => {
      if (leg.needsManualCheck) {
        lines.push(`  Leg ${li + 1}: ${leg.match} -- pick "${leg.raw}" -- COULD NOT TRANSLATE, check manually`);
      } else {
        lines.push(`  Leg ${li + 1}: ${leg.match} -- ${leg.market}: back "${leg.selection}"`);
      }
    });
    lines.push("");
  });
  return lines.join("\n");
}

export { buildBetfairExport, formatBetfairExportText, translatePick, teamName };
