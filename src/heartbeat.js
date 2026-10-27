/**
 * A heartbeat file, so a silent death leaves a trace with a timestamp.
 *
 * The gateway once vanished during a `/api/speak` request: the log ended at "tts ready",
 * stderr was zero bytes, and there was no `uncaughtException` entry - which rules out a
 * JavaScript throw, since that handler logs before doing anything else. What is left is
 * a process killed from outside (its parent shell exiting, a supervisor, the OS), and
 * from inside the process there is no way to observe that. There is no callback for
 * "someone is about to terminate me".
 *
 * What can be observed is the *absence* of evidence. This writes a small file every few
 * seconds containing the pid, the time and what the gateway was doing. If the process
 * dies without shutting down cleanly, the file stops advancing while still claiming to
 * be alive - and the next start can compare that against the wall clock and report how
 * long the gap was and what the last thing in flight was. That turns "it disappeared"
 * into "it disappeared between these two timestamps while handling this request".
 *
 * Deliberately a file rather than a database or a log line: it must survive a kill -9,
 * which means it cannot depend on anything flushing on the way out. `writeFileSync` to a
 * fresh path and a rename is atomic enough for a single writer.
 */

import { writeFileSync, renameSync, mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './config.js';
import { log } from './log.js';

const HEARTBEAT_MS = 5_000;

let timer = null;
let lastActivity = 'idle';
let lastError = null;

/** Where the heartbeat lives. */
function heartbeatPath() {
  return join(paths.root, 'output', 'logs', 'heartbeat.json');
}

/** The lock that says one gateway owns this directory. */
function lockPath() {
  return join(paths.root, 'output', 'logs', 'gateway.pid');
}

/**
 * Is a process with this pid alive?
 *
 * `process.kill(pid, 0)` is the portable test: it throws ESRCH when nothing is there,
 * and EPERM when something is there but owned by another user - either way, "there is
 * a process".
 *
 * @param {number} pid - process id.
 * @returns {boolean} whether it exists.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Refuse to start when another gateway already owns this directory.
 *
 * Cheap insurance: two gateways on one port is already impossible, but two started
 * seconds apart would fight over the same child services - the second one's "stop" would
 * kill the first one's model mid-generation. Failing here says so plainly.
 *
 * @returns {{ok: boolean, existingPid?: number}} whether this process may proceed.
 */
export function acquireLock() {
  const path = lockPath();
  mkdirSync(join(paths.root, 'output', 'logs'), { recursive: true });

  if (existsSync(path)) {
    let previous = null;
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // A corrupt lock is not a reason to refuse to run; the pid check below decides.
    }

    if (previous && pidAlive(Number(previous.pid)) && Number(previous.pid) !== process.pid) {
      return { ok: false, existingPid: Number(previous.pid) };
    }
  }

  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  return { ok: true };
}

/** Remove the lock, if it is ours. */
export function releaseLock() {
  try {
    const path = lockPath();
    if (!existsSync(path)) return;
    const held = JSON.parse(readFileSync(path, 'utf8'));
    if (Number(held.pid) === process.pid) unlinkSync(path);
  } catch {
    // Best effort: a stale lock is detected by the pid check on the next start.
  }
}

/**
 * Read the previous heartbeat and describe an unclean death.
 *
 * @returns {string|null} a sentence for the log, or null when the last run was clean.
 */
export function inspectPreviousRun() {
  const path = heartbeatPath();
  if (!existsSync(path)) return null;

  let previous = null;
  try {
    previous = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'previous heartbeat file was unreadable; its last state is unknown';
  }

  if (previous.cleanExit === true) return null;

  const last = Date.parse(previous.at);
  const ageSec = Number.isFinite(last) ? Math.round((Date.now() - last) / 1000) : null;
  const quiet = ageSec === null ? 'unknown' : `${ageSec}s before this start`;

  return (
    `previous run ended without a clean shutdown (pid ${previous.pid}, last heartbeat ` +
    `${previous.at}, ${quiet}). Last activity: ${previous.activity ?? 'unknown'}` +
    (previous.lastError ? `; last error: ${previous.lastError}` : '') +
    '. A clean exit always rewrites this file, so the absence of one means the process ' +
    'was terminated from outside or died in native code.'
  );
}

/**
 * Record what the gateway is currently doing, for the next run to find.
 *
 * @param {string} activity - short description, e.g. "POST /api/speak tts".
 */
export function noteActivity(activity) {
  lastActivity = activity;
}

/** Record the last error, so a death after an error carries the context. */
export function noteError(message) {
  lastError = String(message ?? '').slice(0, 300);
}

/** Write the heartbeat once. */
function beat(cleanExit = false) {
  const payload = {
    pid: process.pid,
    at: new Date().toISOString(),
    activity: lastActivity,
    lastError,
    uptimeSec: Math.round(process.uptime()),
    cleanExit,
  };

  try {
    const target = heartbeatPath();
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    renameSync(temporary, target);
  } catch {
    // A heartbeat that cannot be written must never break a request.
  }
}

/** Begin beating. */
export function startHeartbeat() {
  beat();
  timer = setInterval(() => beat(), HEARTBEAT_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Mark the run as having ended on purpose.
 *
 * Called from the shutdown path. If this is never reached, the next start reports an
 * unclean death - which is the whole point: it distinguishes "I stopped it" from "it
 * stopped".
 */
export function markCleanExit(reason) {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  lastActivity = `clean shutdown: ${reason}`;
  beat(true);
}

/**
 * The live state, for `GET /api/heartbeat`.
 *
 * Read from the process rather than from the file: the file is the record for the *next*
 * start, while a caller asking now wants to know what this process is doing at this
 * moment.
 *
 * @returns {object} current heartbeat view.
 */
export function current() {
  return {
    pid: process.pid,
    at: new Date().toISOString(),
    activity: lastActivity,
    lastError,
    uptimeSec: Math.round(process.uptime()),
    intervalMs: HEARTBEAT_MS,
  };
}

export { HEARTBEAT_MS };