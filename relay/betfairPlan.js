// Turns one player's exported bet (buildBetfairExport's per-header entry --
// see betfairExport.js) into an ordered, browser-agnostic action plan for
// the Stagehand driver. Pure function, no browser/network involved, so it's
// testable the same way as the rest of relay/ (node --test).
//
// Ordering follows SPORTSBOOK_RECON.md's own findings: all Match Odds legs
// get picked directly from the EPL fixtures list first (cheap, no
// navigation), then Correct Score / Over-Under Goals legs get picked from
// each match's own page second. matchesNeeded carries every match this
// player's accumulator touches (Match Odds legs AND special-market legs
// alike) so the driver can capture each match's href from the single
// fixtures-list pass, before it ever needs to navigate to a match page --
// per the recon notes, guessing a match-page URL instead of reading it off
// the fixtures-list link is exactly what risks a wrong/stale slug.
//
// The same-match "Bet Builder" gotcha from SPORTSBOOK_RECON.md can't
// actually occur with this product's data shape -- buildBetfairExport()
// pushes at most one leg per match per column (one cell = one pick), so two
// legs on the same match within a single accumulator shouldn't be
// possible. checkSameMatchConflicts() is kept as a defensive check anyway,
// flagged rather than trusted blindly -- an assumption about someone else's
// data shape holding forever is exactly the kind of thing this whole
// project has learned not to trust without verifying.
function splitMatch(matchLabel) {
  const parts = String(matchLabel || "").split(" vs ");
  return { homeTeam: (parts[0] || "").trim(), awayTeam: (parts[1] || "").trim() };
}

// One Match Odds leg -> which of the fixtures-list row's three price
// buttons to click, by position (home/draw/away), matching the header row
// "1 X 2" documented in SPORTSBOOK_RECON.md -- the buttons are price-only,
// with no team name in their accessible name, so the driver has to know
// which position it wants ahead of time rather than reading it off the
// button itself.
function matchOddsPosition(leg, homeTeam, awayTeam) {
  if (leg.selection === "The Draw") return "draw";
  if (leg.selection === homeTeam) return "home";
  if (leg.selection === awayTeam) return "away";
  return null; // selection doesn't match either team name or "The Draw" -- data anomaly, flag it
}

// market string -> the match-page tab the recon file says to use.
function specialMarketTab(market) {
  if (market === "Correct Score") return "all-markets";
  if (market && market.startsWith("Over/Under")) return "popular";
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
      const position = matchOddsPosition(leg, homeTeam, awayTeam);
      if (!position) {
        skipped.push({ ...leg, reason: `selection "${leg.selection}" matches neither team name` });
        return;
      }
      listSteps.push({ type: "list-pick", match: leg.match, homeTeam, awayTeam, position, selection: leg.selection });
      return;
    }

    const tab = specialMarketTab(leg.market);
    if (!tab) {
      skipped.push({ ...leg, reason: `unrecognized market "${leg.market}"` });
      return;
    }
    matchPageSteps.push({ type: "match-page-pick", match: leg.match, homeTeam, awayTeam, market: leg.market, selection: leg.selection, tab });
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
// case). A non-empty result means don't proceed as a normal accumulator --
// surface it rather than silently building a same-match Bet Builder combo.
function checkSameMatchConflicts(steps) {
  const counts = {};
  steps.forEach((s) => { counts[s.match] = (counts[s.match] || 0) + 1; });
  return Object.keys(counts).filter((m) => counts[m] > 1);
}

export { buildBetPlan, checkSameMatchConflicts, splitMatch };
