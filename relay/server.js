// Juice Bets live-score relay.
//
// What this replaces: index.html polling Apps Script's ?mode=fast endpoint
// on a timer to notice a score changed. Apps Script/Sheets stays the source
// of truth for everything else (bets, admin, ranking, stats) -- this only
// ever touches live match state.
//
// What it does: polls API-Football's live-fixtures endpoint on its own
// interval, and the instant a fixture's status/score differs from what it
// last saw, pushes just that change to every connected WebSocket client.
// Detecting "is this bet winning" / "did a column just turn green" stays
// entirely client-side in index.html, exactly like it already does for the
// sweat-pulse glow -- this relay only ever hands over raw match state.
//
// MOCK_MODE=1 runs against a small built-in fixture simulator instead of a
// real API-Football call, so this can be built and proven correct without
// an API key. Phase 1 (this file) is exactly that: prove a change reaches a
// connected client in well under a second. Wiring index.html to actually
// listen is Phase 2, done separately once this is trusted.

import { WebSocketServer } from "ws";
import http from "http";

const PORT = parseInt(process.env.PORT || "8787", 10);
// Conservative default matches the Pro plan's safe budget (see the cost
// plan) -- drop this via env var once/if the Ultra upgrade goes through.
// Doesn't change any code, just the interval.
const POLL_MS = parseInt(process.env.POLL_MS || "10000", 10);
const MOCK_MODE = process.env.MOCK_MODE === "1";
const API_KEY = process.env.API_FOOTBALL_KEY || "";
const LEAGUE_ID = process.env.LEAGUE_ID || "39"; // Premier League, matches Code.gs's default
const SEASON = process.env.SEASON || "2026";

if (!MOCK_MODE && !API_KEY) {
  console.error("API_FOOTBALL_KEY is required outside MOCK_MODE. Set MOCK_MODE=1 to run against simulated data instead.");
  process.exit(1);
}

// fixtureId -> { status, score, elapsed, match }
const lastKnown = new Map();
const clients = new Set();

const server = http.createServer((req, res) => {
  // Manual test trigger -- MOCK_MODE only, so this never becomes a stray
  // public control surface once real matches are actually being tracked.
  // Open /trigger on any browser (e.g. a computer) and click a button to
  // fire a fake event on demand, then check a connected client (e.g.
  // test.html on a phone) for the reaction -- no waiting on a timer, no
  // need for a real live match.
  if (MOCK_MODE && req.method === "GET" && req.url === "/trigger") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(TRIGGER_PAGE);
    return;
  }
  if (MOCK_MODE && req.method === "POST" && req.url === "/trigger") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let action = null;
      try { action = JSON.parse(body || "{}").action; } catch (e) { /* leave null */ }
      applyTestAction(action);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(testState));
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("juice-bets live-score relay\n");
});
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
  // A client that just connected shouldn't sit blank until the next actual
  // change -- hand it everything currently known right away.
  ws.send(JSON.stringify({
    type: "snapshot",
    fixtures: [...lastKnown.entries()].map(([id, v]) => ({ id, ...v })),
  }));
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

async function fetchLiveFixtures() {
  if (MOCK_MODE) return mockFixtures();
  const res = await fetch(
    `https://v3.football.api-sports.io/fixtures?live=all&league=${LEAGUE_ID}&season=${SEASON}`,
    { headers: { "x-apisports-key": API_KEY } }
  );
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  const data = await res.json();
  return (data.response || []).map((f) => ({
    id: f.fixture.id,
    status: f.fixture.status.short,
    elapsed: f.fixture.status.elapsed,
    score: `${f.goals.home ?? 0}-${f.goals.away ?? 0}`,
    match: `${f.teams.home.name} - ${f.teams.away.name}`,
  }));
}

// -- Phase 1 mock, so this whole pipeline can be proven without a real key --
let mockTick = 0;
function mockFixtures() {
  mockTick++;
  const scored = mockTick >= 3; // simulate a goal landing a couple of polls in
  return [{
    id: 999001,
    status: "LIVE",
    elapsed: Math.min(mockTick * 2, 90),
    score: scored ? "1-0" : "0-0",
    match: "ARS - CHE",
  }];
}

// -- Manual test trigger (MOCK_MODE only) --
// A client listening for pushes (see index.html/test.html's connectRelay())
// doesn't actually look at what this message says -- ANY message just tells
// it "go check now" and it re-polls Apps Script for the real truth. So the
// exact fake values below don't need to be realistic; they only need to
// change something, so a broadcast actually goes out.
let testState = { status: "NS", score: "0-0", elapsed: 0 };

function applyTestAction(action) {
  const [homeStr, awayStr] = testState.score.split("-");
  let home = parseInt(homeStr, 10) || 0;
  let away = parseInt(awayStr, 10) || 0;
  switch (action) {
    case "kickoff": testState = { status: "LIVE", score: "0-0", elapsed: 1 }; break;
    case "goal_home": home += 1; testState = { ...testState, status: "LIVE", score: `${home}-${away}` }; break;
    case "goal_away": away += 1; testState = { ...testState, status: "LIVE", score: `${home}-${away}` }; break;
    case "ht": testState = { ...testState, status: "HT" }; break;
    case "2h": testState = { ...testState, status: "LIVE", elapsed: 46 }; break;
    case "ft": testState = { ...testState, status: "FT" }; break;
    case "reset": testState = { status: "NS", score: "0-0", elapsed: 0 }; break;
    default: return; // unrecognized action -- no-op, nothing broadcast
  }
  lastKnown.set(999001, { ...testState, match: "ARS - CHE" });
  broadcast({ type: "update", fixture: { id: 999001, ...testState, match: "ARS - CHE" }, detectedAt: Date.now() });
}

const TRIGGER_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay test trigger</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0f0c; color: #eaf1ec; padding: 24px 20px 40px; max-width: 420px; margin: 0 auto; }
  h1 { font-size: 17px; margin-bottom: 4px; }
  p { color: #8fa396; font-size: 13px; margin-top: 0; }
  button { display: block; width: 100%; padding: 14px; margin: 8px 0; border-radius: 8px; border: 1px solid #2a352d; background: #141b16; color: #eaf1ec; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:active { background: #1e2a22; }
  button.danger { border-color: #4a2323; color: #ff9b9b; }
  #state { font-family: monospace; font-size: 12px; color: #8fa396; margin-top: 18px; white-space: pre-wrap; background: #10150f; padding: 10px 12px; border-radius: 8px; border: 1px solid #222; }
</style></head>
<body>
  <h1>Juice Bets relay -- test trigger</h1>
  <p>Click a button here, then check a connected client (e.g. test.html on your phone).</p>
  <button onclick="fire('kickoff')">Kickoff</button>
  <button onclick="fire('goal_home')">⚽ Goal -- Home</button>
  <button onclick="fire('goal_away')">⚽ Goal -- Away</button>
  <button onclick="fire('ht')">Half Time</button>
  <button onclick="fire('2h')">Second Half</button>
  <button onclick="fire('ft')">Full Time</button>
  <button class="danger" onclick="fire('reset')">Reset</button>
  <div id="state">(no action fired yet)</div>
  <script>
    async function fire(action) {
      const res = await fetch('/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await res.json();
      document.getElementById('state').textContent = JSON.stringify(data, null, 2);
    }
  </script>
</body></html>`;

async function pollOnce() {
  let fixtures;
  try {
    fixtures = await fetchLiveFixtures();
  } catch (err) {
    console.error("poll failed:", err.message);
    return;
  }
  for (const f of fixtures) {
    const prev = lastKnown.get(f.id);
    const changed = !prev || prev.status !== f.status || prev.score !== f.score;
    if (!changed) continue;
    const entry = { status: f.status, score: f.score, elapsed: f.elapsed, match: f.match };
    lastKnown.set(f.id, entry);
    broadcast({ type: "update", fixture: { id: f.id, ...entry }, detectedAt: Date.now() });
  }
}

setInterval(pollOnce, POLL_MS);
server.listen(PORT, () => {
  console.log(`relay listening on :${PORT} -- polling every ${POLL_MS}ms, mock=${MOCK_MODE}`);
});
