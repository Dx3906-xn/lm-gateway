/**
 * Starting and stopping a service, and waiting for it to actually be usable.
 *
 * Two details here come from how these particular services behave on this machine:
 *
 * 1. Reachability is not the same as an HTTP 200. GPT-SoVITS answers `/tts` with an
 *    error when called without parameters, and that error still proves the process
 *    is listening. So the readiness test is "the TCP connection completed and an
 *    HTTP response came back", whatever its status.
 *
 * 2. Stopping must be confirmed, not assumed. A cold ComfyUI holds ~5.7 GB; starting
 *    the next model before that memory is actually released is how a start fails for
 *    no visible reason. So stop waits for the port to stop answering.
 */

import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { getConfig, paths } from './config.js';
import * as registry from './registry.js';
import { readyUrl, applyPort } from './ports.js';

const DEFAULT_SCRIPTS_DIR = 'E:\\B\\scripts';

/**
 * Short-lived reachability cache, keyed by "METHOD url".
 *
 * Sized just above the WebUI's 2 s status poll: long enough that one poll cannot
 * re-probe the same service twice, short enough that a service appearing or vanishing
 * is still visible on the next poll.
 */
const PROBE_CACHE_MS = 2_500;
const probeCache = new Map();

/** Where the PowerShell helpers live, from config with a sane fallback. */
function scriptsDir() {
  return getConfig().gateway?.scriptsDir ?? DEFAULT_SCRIPTS_DIR;
}

/**
 * Turn a start/stop spec into an argv pair.
 *
 * Three shapes are accepted so the config stays readable:
 *   { script: "start_comfy.ps1", args: [...] }   - run through PowerShell
 *   { cmd: "C:\\path\\to.exe", args: [...] }      - run directly
 *   { cmd: "C:\\path\\to.exe subcommand" }        - legacy single string, split here
 *
 * @param {object} spec - start or stop block.
 * @returns {{file: string, args: string[]}} what to spawn.
 */
function resolveCommand(spec) {
  if (spec.script) {
    return {
      file: 'powershell',
      args: [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', join(scriptsDir(), spec.script),
        ...(spec.args ?? []),
      ],
    };
  }

  if (spec.cmd) {
    if (Array.isArray(spec.cmd)) {
      return { file: spec.cmd[0], args: [...spec.cmd.slice(1), ...(spec.args ?? [])] };
    }
    // Split on whitespace but keep quoted runs together. The documented form puts
    // arguments in `args`, so this only has to handle the simple legacy case.
    const parts = String(spec.cmd).match(/"[^"]+"|\S+/g) ?? [];
    const unquoted = parts.map((part) => part.replace(/^"|"$/g, ''));
    return { file: unquoted[0], args: [...unquoted.slice(1), ...(spec.args ?? [])] };
  }

  throw new Error('command spec has neither "script" nor "cmd"');
}

/**
 * Run a command to completion, or hand control to a service that never completes.
 *
 * Output goes to a file rather than a pipe, and that is not a style choice. Measured
 * on this machine: `start_comfy.ps1` launches ComfyUI with `Start-Process`, the child
 * inherits the launcher's stdout/stderr pipes, and Node's `close` event then never
 * fires - the gateway reported "command timed out after 120000ms" while ComfyUI was in
 * fact up and answering `/system_stats`. A file handle does not keep the event open
 * the same way, so the launcher's exit is observed correctly.
 *
 * `spec.detached` covers the other shape a start command can take. Some services are
 * started by a wrapper that backgrounds them and exits (the three `.ps1` scripts);
 * others *are* the service, so the command's exit is its shutdown, not its completion.
 * `serve.py` is the second kind, and waiting for it to exit meant waiting forever: the
 * gateway killed a service that had been healthy for 117 seconds because the wait
 * looked like a hang. When `detached` is set, the command is launched and control
 * returns at once; whether it actually came up is decided by the readiness URL, which
 * is the only authority that was ever correct for a long-running process.
 *
 * @param {object} spec - start or stop block, optionally with `detached`.
 * @param {number} timeoutMs - hard limit for the wait, when there is one.
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runCommand(spec, timeoutMs = 120_000) {
  const { file, args } = resolveCommand(spec);
  const detached = spec.detached === true;

  const logDir = join(paths.root, 'output', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(
    logDir,
    `command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
  );
  const handle = openSync(logFile, 'a');

  return new Promise((resolve, reject) => {
    // `env` carries values a service takes from the environment rather than from argv -
    // the embedding server reads EMBED_PORT, which is how its port became dynamic without
    // touching its code. Merged onto the inherited environment rather than replacing it,
    // because these services need PATH for FFmpeg DLLs and similar.
    const environment = spec.env ? { ...process.env, ...spec.env } : process.env;

    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', handle, handle],
      env: environment,
    });

    let settled = false;
    let timer = null;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        closeSync(handle);
      } catch {
        // Already closed on an error path; nothing to do.
      }
      settle(value);
    };

    const readOutput = () => {
      try {
        return readFileSync(logFile, 'utf8').trim();
      } catch {
        // Unreadable log is not a reason to lose the exit code.
        return '';
      }
    };

    if (detached) {
      // A long-running service must not be waited on, but a command that dies in the
      // first instant (bad path, missing module) should still be reported as a failure
      // rather than turning into a readiness timeout a minute later. Give it a moment
      // to fail fast, then hand off.
      const settleDelayMs = spec.detachedGraceMs ?? 700;

      timer = setTimeout(() => {
        // Deliberately not unref'd: the gateway owns this service's lifetime and stops
        // it on the way down. Detaching the handle would let a crash strand it holding
        // GBs of VRAM with nothing left to reclaim it.
        finish(resolve, {
          code: 0,
          stdout: `${file} launched detached; readiness decides success`,
          stderr: '',
        });
      }, settleDelayMs);

      child.on('error', (error) => finish(reject, error));

      child.on('close', (code) => {
        // Exited inside the grace window: this is a start failure, not a service.
        finish(reject, new Error(
          `detached start command exited immediately with code ${code}: ` +
          `${readOutput().slice(0, 300) || 'no output'}`,
        ));
      });

      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The process may already be gone; the timeout still stands.
      }
      finish(reject, new Error(`command timed out after ${timeoutMs}ms: ${file}`));
    }, timeoutMs);

    child.on('error', (error) => finish(reject, error));

    child.on('close', (code) => {
      // Both streams land in one file, so the merged text is returned as stdout and
      // stderr stays empty; callers already prefer whichever is non-empty.
      finish(resolve, { code, stdout: readOutput(), stderr: '' });
    });
  });
}

/**
 * Is something answering at this URL?
 *
 * Any HTTP status counts. See the note at the top of the file: a 400 from a service
 * that is up must not read as "still starting", or every start of that service would
 * burn its whole timeout.
 *
 * Results are cached briefly for the status path and bypassed for readiness polling.
 * Two reasons, both learned the hard way:
 *
 *   - The WebUI polls `/api/status` every 2 s, and that walks every resource. Without
 *     a cache each poll opened a fresh connection to each service, and a probe that
 *     timed out was aborted mid-response - which the service sees as a client
 *     disconnect (`ConnectionResetError` on the Python side) and logs as an error, even
 *     though nothing was wrong with it.
 *   - `image` and `breeze` share port 8188, so one status pass was probing the same
 *     URL twice.
 *
 * `waitReady` passes `fresh: true`, because it is watching for a change and a cached
 * answer would defeat the point.
 *
 * @param {string} url - probe target.
 * @param {string} method - GET or HEAD.
 * @param {number} timeoutMs - per-attempt limit.
 * @param {object} [options] - `fresh` skips the cache.
 * @returns {Promise<boolean>} whether an HTTP response arrived.
 */
export async function isReachable(url, method = 'GET', timeoutMs = 5_000, { fresh = false } = {}) {
  const key = `${method} ${url}`;
  const now = Date.now();
  const cached = probeCache.get(key);

  if (!fresh && cached && now - cached.at < PROBE_CACHE_MS) return cached.ok;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let ok = false;
  try {
    await fetch(url, { method, signal: controller.signal, redirect: 'manual' });
    ok = true;
  } catch {
    ok = false;
  } finally {
    clearTimeout(timer);
  }

  probeCache.set(key, { at: now, ok });
  return ok;
}

/**
 * Poll a resource's readiness URL until it answers or the budget runs out.
 *
 * @param {object} resource - config entry.
 * @param {number} timeoutSec - from the config's ready block.
 * @returns {Promise<boolean>} true when ready.
 */
async function waitReady(resource, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const method = resource.ready?.method ?? 'GET';

  while (Date.now() < deadline) {
    // fresh: this loop exists to observe a change, so a cached answer would defeat it.
    if (await isReachable(readyUrl(resource), method, 5_000, { fresh: true })) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

/**
 * Wait for a URL to stop answering.
 *
 * `fresh` matters here more than anywhere: a cached "yes it answers" would keep this
 * loop from ever observing the shutdown it is waiting for, and every stop would then
 * sit until its timeout and report failure.
 *
 * @param {string} url - probe target.
 * @param {number} timeoutSec - how long to wait.
 * @returns {Promise<boolean>} true when it stopped answering.
 */
async function waitGone(url, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (!(await isReachable(url, 'GET', 2_000, { fresh: true }))) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Start one resource and wait for it to answer.
 *
 * @param {string} id - resource id.
 * @returns {Promise<{ok: boolean, error?: string}>} the outcome.
 */
export async function start(id) {
  const config = getConfig();
  const resource = config.resources[id];
  if (!resource) throw new Error(`unknown resource: ${id}`);

  const state = registry.entry(id);

  // Already up - but distinguish "we started it" from "a human did", so a later
  // idle release does not shut down something the operator wants to keep.
  if (await isReachable(readyUrl(resource), resource.ready?.method ?? 'GET', 5_000, { fresh: true })) {
    registry.markExternal(id);
    state.state = 'ready';
    log.info(`${id} already running; leaving ownership alone`);
    return { ok: true };
  }

  state.state = 'starting';
  state.lastError = null;
  log.info(`starting ${id}`, { port: resource.port, vramMiB: resource.vramMiB });

  try {
    // The allocated port is substituted into the command here rather than stored in the
    // config: the config says `{port}` (or nothing), and the number only becomes real once
    // it has been confirmed free. See ports.js.
    const startSpec = applyPort(resource.start, resource.port);
    const result = await runCommand(startSpec, resource.start.timeoutMs ?? 120_000);
    if (result.code !== 0) {
      // A launcher that exits non-zero usually explained itself on stdout; that text
      // is the only thing that says which failure mode this was.
      const detail = result.stderr || result.stdout || `exit ${result.code}`;
      throw new Error(detail.slice(0, 400));
    }
  } catch (error) {
    const message = String(error?.message ?? error);

    // A launcher that timed out has not necessarily failed, so ask the service itself
    // before reporting a failure. Combined with the file-based output above, this is
    // the second half of the same defence: the wait is not authoritative about whether
    // the process came up, only the readiness URL is.
    if (await isReachable(readyUrl(resource), resource.ready?.method ?? 'GET', 5_000, { fresh: true })) {
      log.warn(`${id} launcher timed out but the service is answering; treating it as started`);
      state.state = 'ready';
      state.startedByUs = true;
      state.startedAt = Date.now();
      return { ok: true };
    }

    state.state = 'idle';
    registry.setError(id, message);
    log.error(`${id} start command failed`, message.slice(0, 300));
    return { ok: false, error: message };
  }

  state.startedByUs = true;
  state.startedAt = Date.now();

  const timeoutSec = resource.ready?.timeoutSec ?? 180;
  if (!(await waitReady(resource, timeoutSec))) {
    const message = `${id} did not answer ${readyUrl(resource)} within ${timeoutSec}s`;
    registry.setError(id, message);
    log.error(message);
    // A service that never answered would otherwise sit on the card and block the
    // next attempt, so clean it up rather than leaving it resident.
    await stop(id, { force: true }).catch(() => {});
    state.state = 'idle';
    return { ok: false, error: message };
  }

  state.state = 'ready';
  state.yielded = false;
  log.info(`${id} ready`, { tookMs: Date.now() - (state.startedAt ?? Date.now()) });
  return { ok: true };
}

/**
 * Stop one resource and wait for its port to be released.
 *
 * @param {string} id - resource id.
 * @param {object} [options] - force skips the "in use" guard.
 * @returns {Promise<{ok: boolean, error?: string}>} the outcome.
 */
export async function stop(id, { force = false } = {}) {
  const config = getConfig();
  const resource = config.resources[id];
  if (!resource) throw new Error(`unknown resource: ${id}`);

  const state = registry.entry(id);

  // Refuse to yank a model out from under an in-flight request unless forced. The
  // WebUI switch is the forced path: a user who flips it off asked for the memory
  // back now.
  if (!force && state.inflight > 0) {
    state.state = 'busy';
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (state.inflight > 0) {
      return { ok: false, error: `${id} has ${state.inflight} request(s) in flight` };
    }
  }

  state.state = 'stopping';

  if (!(await isReachable(readyUrl(resource), 'GET', 3_000, { fresh: true }))) {
    state.state = 'idle';
    state.startedByUs = false;
    state.startedAt = null;
    return { ok: true };
  }

  log.info(`stopping ${id}`);

  try {
    if (resource.stop?.url) {
      // Graceful shutdown endpoint: these services flush and exit on their own. The URL
      // may contain {port} because the embedding server's port is no longer fixed.
      const url = resource.stop.url.replaceAll('{port}', String(resource.port ?? ''));
      await fetch(url, { method: 'POST' }).catch(() => {});
    } else {
      const stopSpec = applyPort(resource.stop, resource.port);
      const result = await runCommand(stopSpec, resource.stop.timeoutMs ?? 60_000);
      if (result.code !== 0) {
        log.warn(`${id} stop command exited ${result.code}`, (result.stderr || result.stdout).slice(0, 200));
      }
    }
  } catch (error) {
    log.warn(`${id} stop command failed`, String(error?.message ?? error).slice(0, 200));
  }

  const gone = await waitGone(readyUrl(resource), resource.stop.waitSec ?? 30);
  state.state = 'idle';
  state.startedByUs = false;
  state.startedAt = null;
  state.yielded = false;

  if (!gone) {
    const message = `${id} still answers after stop`;
    registry.setError(id, message);
    return { ok: false, error: message };
  }

  log.info(`${id} stopped`);
  return { ok: true };
}

export { resolveCommand, runCommand };