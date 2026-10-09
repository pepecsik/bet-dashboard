// Deterministic, zero-LLM background poller for the betfair-place-request
// queue -- replaces the OpenClaw-agent-based cron job that previously did
// this job's exact work via an LLM reading PLACEMENT_MANUAL.md every ~30s.
//
// Added 2026-10-02 after Winston's own explicit ask: that cron job cost
// real tokens every single tick, forever, even when there was nothing to
// do -- and, more importantly, it was the actual root cause of an entire
// week-plus of real, separate bugs (a caching fetch tool silently hiding
// the live queue state, a stale local workspace doc claiming this manual
// didn't exist, confusing a claim-on-read endpoint for a safe peek,
// inventing a fake test job on an empty queue, even once hallucinating a
// decision-rejection call). Every one of those came from asking a model to
// exercise judgment over a decision that has never actually needed any:
// "is there a pending job -- if so, run driver.js." That's a plain
// if/else, not a task an LLM should be in the loop for at all.
//
// This script IS that if/else, nothing more. It costs nothing beyond the
// relay's own trivial GET /betfair-place-request/queue every interval, and
// it's immune by construction to every bug class above -- there's no model
// here to misread a tool, a stale doc, or an endpoint's semantics.
//
// driver.js's own narrow Stagehand AI fallback (for the one specific leg
// that fails deterministically) is completely unaffected -- that's a
// different, already-scoped use of a model, inside the one process this
// script spawns, not in the polling decision itself.
//
// Meant to just always be running in the background, the same way
// caffeinate/TeamViewer already keep the Mac itself awake -- see this
// file's own README "Setup" section for how to launch it persistently.

import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const RELAY_URL = process.env.RELAY_URL || "https://bet-dashboard-relay.onrender.com";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const DRIVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "driver.js");
const BROWSER_PROFILE = process.env.BETANO_BROWSER_PROFILE || "betano";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Tracks only what THIS process itself spawned -- a cheap optimization to
// avoid a wasted spawn attempt while a build is already running, not a
// safety mechanism. The real safety against a double-claim is already the
// relay's own queue exclusivity (getNext() refuses a second claim while
// anything is claimed/awaiting-confirmation, regardless of who's asking) --
// even if this check were somehow wrong, a second driver.js invocation
// would just find nothing left to claim and exit harmlessly, exactly like
// a manually-invoked one would.
let driverRunning = false;

// Confirmed live (2026-10-09): the betano Chrome profile itself can just
// stop running during the week between normal runs (not a login issue --
// a genuine ECONNREFUSED on the CDP port), same "nobody's watching to
// notice" risk class as the login problem this file already fixed once.
// `openclaw browser start --browser-profile <name> --json` is confirmed
// idempotent (a no-op if already running) and reports real status --
// always called right before a build attempt, not just when something's
// already detected as down, per OpenClaw's own live-verified guidance.
// Returns the confirmed real CDP URL to use (reading cdpPort back rather
// than trusting a hardcoded default, since it's drifted before on a full
// profile re-registration), or null if the browser genuinely couldn't be
// confirmed running/ready -- callers must not proceed to spawn driver.js
// against a URL this didn't actually confirm.
async function ensureBrowserRunning() {
  let stdout;
  try {
    const result = await execFileAsync("openclaw", ["browser", "start", "--browser-profile", BROWSER_PROFILE, "--json"], { timeout: 20000 });
    stdout = result.stdout;
  } catch (err) {
    console.error(`[poll] "openclaw browser start" failed:`, err.message);
    return null;
  }
  let status;
  try {
    status = JSON.parse(stdout);
  } catch (err) {
    console.error(`[poll] "openclaw browser start" returned unparseable output:`, stdout.slice(0, 500));
    return null;
  }
  // Checking the real JSON fields, not trusting the command's own exit
  // code alone -- same "verify substantively" discipline as everywhere
  // else in this project.
  if (!status.running || !status.cdpReady || !status.cdpPort) {
    console.error(`[poll] Browser start reported not ready:`, JSON.stringify(status));
    return null;
  }
  return `http://127.0.0.1:${status.cdpPort}`;
}

// Capped to avoid spamming Telegram every single 30s tick while the
// browser genuinely can't be started -- one alert is useful, sixty
// identical ones in half an hour are not.
const BROWSER_FAILURE_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
let lastBrowserFailureNotifyAt = 0;

async function notifyBrowserStartFailureDirect() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const now = Date.now();
  if (now - lastBrowserFailureNotifyAt < BROWSER_FAILURE_NOTIFY_COOLDOWN_MS) return;
  lastBrowserFailureNotifyAt = now;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `⚠️ A bet is queued, but the betano browser couldn't be started automatically. Needs someone to check it manually.` }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(JSON.stringify(data));
  } catch (err) {
    console.error(`[poll] Browser-start-failure Telegram notify failed:`, err.message);
  }
}

async function pollOnce() {
  if (driverRunning) return;
  let data;
  try {
    const res = await fetch(`${RELAY_URL}/betfair-place-request/queue`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(`[poll] Failed to reach relay:`, err.message);
    return;
  }
  const hasPending = (data.queue || []).some((r) => r.status === "pending");
  if (!hasPending) return;

  const cdpUrl = await ensureBrowserRunning();
  if (!cdpUrl) {
    console.error(`[poll] Browser could not be confirmed running -- skipping this tick, will retry next poll.`);
    await notifyBrowserStartFailureDirect();
    return;
  }

  console.log(`[poll] Pending job found -- launching driver.js (CDP: ${cdpUrl}).`);
  driverRunning = true;
  const child = spawn("node", [DRIVER_PATH], { stdio: "inherit", env: { ...process.env, BETANO_CDP_URL: cdpUrl } });
  child.on("exit", (code) => {
    console.log(`[poll] driver.js exited with code ${code}.`);
    driverRunning = false;
  });
  child.on("error", (err) => {
    console.error(`[poll] Failed to spawn driver.js:`, err.message);
    driverRunning = false;
  });
}

console.log(`[poll] Starting deterministic poll loop against ${RELAY_URL}, every ${POLL_INTERVAL_MS}ms.`);
setInterval(() => { pollOnce().catch((err) => console.error(`[poll] pollOnce failed:`, err.message)); }, POLL_INTERVAL_MS);
pollOnce().catch((err) => console.error(`[poll] pollOnce failed:`, err.message)); // check immediately on startup, don't wait a full interval
