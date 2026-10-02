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

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RELAY_URL = process.env.RELAY_URL || "https://bet-dashboard-relay.onrender.com";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);
const DRIVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "driver.js");

// Tracks only what THIS process itself spawned -- a cheap optimization to
// avoid a wasted spawn attempt while a build is already running, not a
// safety mechanism. The real safety against a double-claim is already the
// relay's own queue exclusivity (getNext() refuses a second claim while
// anything is claimed/awaiting-confirmation, regardless of who's asking) --
// even if this check were somehow wrong, a second driver.js invocation
// would just find nothing left to claim and exit harmlessly, exactly like
// a manually-invoked one would.
let driverRunning = false;

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

  console.log(`[poll] Pending job found -- launching driver.js.`);
  driverRunning = true;
  const child = spawn("node", [DRIVER_PATH], { stdio: "inherit", env: process.env });
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
