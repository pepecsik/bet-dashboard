// Turns one player's exported bet (buildBetfairExport's per-header entry --
// see betfairExport.js, kept as-is: "Match Odds"/"Correct Score"/"Over/Under
// X Goals" are this app's own generic internal market labels, not literally
// Betfair-specific) into an ordered, browser-agnostic action plan for the
// Betano driver. Pure function, no browser/network involved, testable with
// node --test same as the rest of relay/.
//
// Ordering follows BETANO_RECON.md's own findings: all Match Result legs
// get picked directly from the EPL fixtures list first (cheap, no
// navigation), then Correct Score / Over-Under Goals legs get picked from
// each match's own page second. matchesNeeded carries every match this
// player's accumulator touches (both leg types alike) so the driver can
// capture each match's href from the single fixtures-list pass, before it
// ever needs to navigate to a match page -- per BETANO_RECON.md, Betano
// silently 302-redirects some slugs, so getting the exact href off the
// fixtures-list link (rather than guessing a slug) is what avoids that.
//
// Same-match conflicts can't actually occur with this product's data shape
// (see betfairPlan.js's own history on this, before it was deleted --
// buildBetfairExport-shaped data pushes at most one leg per match per
// column). checkSameMatchConflicts() is kept as a defensive check anyway.
// Note Betano's OWN same-match handling is genuinely different from
// Betfair's if this ever does occur -- System mode with auto-recombination,
// not a Bet Builder swap. See BETANO_RECON.md section 4.
function splitMatch(matchLabel) {
  const parts = String(matchLabel || "").split(" vs ");
  return { homeTeam: (parts[0] || "").trim(), awayTeam: (parts[1] || "").trim() };
}

// One Match Result leg -> which of the fixtures-list row's three price
// buttons to click, by position (home/draw/away) -- Betano's own labels for
// these are "1"/"X"/"2" (see BETANO_RECON.md section 1), mapped to this
// site-agnostic position name here so the driver's own label mapping stays
// in one place, not duplicated into this file too.
function matchResultPosition(leg, homeTeam, awayTeam) {
  if (leg.selection === "The Draw") return "draw";
  if (leg.selection === homeTeam) return "home";
  if (leg.selection === awayTeam) return "away";
  return null; // selection doesn't match either team name or "The Draw" -- data anomaly, flag it
}

// market string -> whether the match-page section needs its accordion
// expanded first. Correct Score is collapsed by default on Betano; Over/
// Under Goals is already expanded on page load -- see BETANO_RECON.md
// section 2. Returns null for anything unrecognized (out of scope).
function specialMarketNeedsExpand(market) {
  if (market === "Correct Score") return true;
  if (market && market.startsWith("Over/Under")) return false;
  return null;
}

function buildBetPlan(exportedBet) {
  const player = exportedBet && exportedBet.player;
  const stake = exportedBet && exportedBet.stake;
  const legs = (exportedBet && exportedBet.legs) || [];

  const listSteps = [];
  const matchPageSteps = [];
  const skipped = [];
  const matchesNeeded = [];
  const seenMatches = new Set();

  legs.forEach((leg) => {
    if (leg.needsManualCheck || !leg.market) {
      skipped.push({ ...leg, reason: "could not translate pick" });
      return;
    }
    const { homeTeam, awayTeam } = splitMatch(leg.match);
    if (!seenMatches.has(leg.match)) {
      seenMatches.add(leg.match);
      matchesNeeded.push({ match: leg.match, homeTeam, awayTeam });
    }

    if (leg.market === "Match Odds") {
      const position = matchResultPosition(leg, homeTeam, awayTeam);
      if (!position) {
        skipped.push({ ...leg, reason: `selection "${leg.selection}" matches neither team name` });
        return;
      }
      listSteps.push({ type: "list-pick", match: leg.match, homeTeam, awayTeam, position, selection: leg.selection });
      return;
    }

    const needsExpand = specialMarketNeedsExpand(leg.market);
    if (needsExpand === null) {
      skipped.push({ ...leg, reason: `unrecognized market "${leg.market}"` });
      return;
    }
    matchPageSteps.push({ type: "match-page-pick", match: leg.match, homeTeam, awayTeam, market: leg.market, selection: leg.selection, needsExpand });
  });

  return {
    player,
    stake,
    matchesNeeded,
    steps: [...listSteps, ...matchPageSteps],
    skipped,
    conflicts: checkSameMatchConflicts([...listSteps, ...matchPageSteps]),
  };
}

// Defensive only -- see the file-level comment. Returns the list of match
// labels that appear in more than one step, empty if none (the expected
// case).
function checkSameMatchConflicts(steps) {
  const counts = {};
  steps.forEach((s) => { counts[s.match] = (counts[s.match] || 0) + 1; });
  return Object.keys(counts).filter((m) => counts[m] > 1);
}

export { buildBetPlan, checkSameMatchConflicts, splitMatch };
