// Pure message-formatting for the live Telegram notifications (rules #4,
// #5A/#5B, #6, #7 from the planning doc) -- kept separate from server.js
// and from where the triggers are detected, same split as every other pure
// module in this relay (scoring.js, columnStats.js, ...), so wording can be
// tested without a live Telegram bot or a live poll tick.

import { teamName } from "./betfairExport.js";

function fmtEUR(v) {
  return "€" + (Number(v) || 0).toFixed(2);
}

// #7 -- plain scoreline, no bet context. Takes the match string as already
// formatted by the live-score poll loop ("Arsenal - Chelsea", full names
// straight from API-Football, no team codes available at that call site --
// unlike betsCache's own "ARS - CHE" code format elsewhere in this relay).
// Returns null if it can't tell which side actually scored (defensive --
// shouldn't happen given the caller only calls this when the score string
// genuinely changed).
function formatGoalMessage(match, prevScore, newScore) {
  const prev = String(prevScore || "0-0").split("-").map((n) => parseInt(n, 10));
  const next = String(newScore || "0-0").split("-").map((n) => parseInt(n, 10));
  if (prev.length !== 2 || next.length !== 2 || prev.some(isNaN) || next.some(isNaN)) return null;
  const [prevH, prevA] = prev;
  const [nextH, nextA] = next;
  const parts = String(match || "").split(" - ");
  if (parts.length !== 2) return null;
  const [homeName, awayName] = parts;
  let scorer = null;
  if (nextH > prevH) scorer = homeName;
  else if (nextA > prevA) scorer = awayName;
  if (!scorer) return null;
  return `⚽ GOAL! ${match} is now ${newScore} (${scorer})`;
}

// #4 -- over the top on purpose, full wins are rare for this group.
function formatBigWinMessage(player, amount) {
  return `🚨🎉 FULL WIN!! 🎉🚨\n${player} just nailed every single pick — ${fmtEUR(amount)} is coming in. Legend status. 🏆🔥`;
}

// #5A
function formatOneMatchAwayMessage(player, amount, match) {
  return `😬 ${player} is one match away from a full win (${fmtEUR(amount)}) — just needs ${match} to go right.`;
}

// #5B -- who needs to score depends on what was picked: the pick's own
// team for a team-win pick, or whichever side is currently trailing for a
// draw pick (the one that would re-level it).
function whoNeedsToScore(pick, homeCode, awayCode, score) {
  const home = String(homeCode || "").trim().toUpperCase();
  const away = String(awayCode || "").trim().toUpperCase();
  const p = String(pick || "").trim().toUpperCase();
  if (p === home) return teamName(homeCode);
  if (p === away) return teamName(awayCode);
  // Draw pick -- find the trailing side, they're the one who levels it.
  const parts = String(score || "0-0").split("-").map((n) => parseInt(n, 10));
  if (parts.length !== 2 || parts.some(isNaN)) return null;
  const [h, a] = parts;
  if (h > a) return teamName(awayCode);
  if (a > h) return teamName(homeCode);
  return null; // already level -- shouldn't reach here for a genuine "one goal away" draw pick
}

function formatOneGoalAwayMessage(player, match, homeCode, awayCode, pick, score, minute) {
  const who = whoNeedsToScore(pick, homeCode, awayCode, score);
  if (!who) return null;
  return `⚡ ${player} is one goal away in ${match} (${score}, ${minute}') — needs ${who} to score.`;
}

// Combine rule: the "one goal away" leg is ALSO the column's last remaining
// leg -- one merged message instead of both separate ones.
function formatOneGoalAwayAndLastLegMessage(player, amount, match, homeCode, awayCode, pick, score, minute) {
  const who = whoNeedsToScore(pick, homeCode, awayCode, score);
  if (!who) return null;
  return `😬⚡ ${player} is ONE GOAL away from a full win (${fmtEUR(amount)}) — ${who} scores in ${match} (${score}, ${minute}') and that's it.`;
}

// #6 -- single or batched, per the "pile-on, not individual drama" call.
// entries: [{ player, match, finalScore }]
function formatBetDiedMessage(entries) {
  if (!entries || !entries.length) return null;
  if (entries.length === 1) {
    const e = entries[0];
    return `💀 RIP ${e.player}'s bet. ${e.match} (final: ${e.finalScore}) just put it in the ground.`;
  }
  const lines = entries.map((e) => `• ${e.player}'s bet — ${e.match} (final: ${e.finalScore})`);
  return `💀 Bets just died this round:\n${lines.join("\n")}`;
}

// #3A -- matches: [{ match, time }], all sharing the earliest kickoff.
function formatKickoff30MinMessage(matches) {
  if (!matches || !matches.length) return null;
  const lines = matches.map((m) => `${m.match} (${m.time})`);
  return `⏰ First kickoff of the week is starting in 30 min:\n${lines.join("\n")}`;
}

// #3B -- static wording, kept as a function for consistency with the rest
// of this module and in case the wording needs match-specific detail later.
function formatDayBeforeMessage() {
  return `📣 First kickoff is tomorrow — place your bets if you haven't yet!`;
}

// #1 -- bets locked + highest possible win. Built here (reused by nothing
// server-side -- Code.gs sends its own version of this text directly) only
// so the exact wording lives in one tested place; Code.gs's copy must be
// kept in sync by hand since Apps Script can't import this module.
function formatBetsLockedMessage(day, time, highestWin, highestWinPerPerson) {
  let msg = `🔒 Bets locked — matchweek is live. First kickoff: ${day} ${time}.`;
  if (highestWin > 0) {
    msg += `\n💰 Highest possible win this week: ${fmtEUR(highestWin)} (${fmtEUR(highestWinPerPerson)} each)`;
  }
  return msg;
}

export {
  fmtEUR,
  formatGoalMessage,
  formatBigWinMessage,
  formatOneMatchAwayMessage,
  formatOneGoalAwayMessage,
  formatOneGoalAwayAndLastLegMessage,
  formatBetDiedMessage,
  formatKickoff30MinMessage,
  formatDayBeforeMessage,
  formatBetsLockedMessage,
  whoNeedsToScore,
};
