/**
 * A service that died must not keep being reported as running.
 *
 * The report: `breeze state=ready running=true port=8188` while 8188 was not listening. The
 * process had exited, the gateway had not noticed, and the idle timer kept re-arming every
 * three minutes - refreshing a claim about something that no longer existed. Callers got a
 * 500 and could not tell "the model broke" from "the gateway is showing stale state". The
 * only recovery was a manual disable/enable cycle.
 *
 * The cause is structural: a service crashes or is killed, and nothing tells the gateway.
 * There is no callback for it, so a recorded `ready` has to be verified rather than trusted.
 * Two places now check: `/api/status` (so the panel is honest) and `ensureRunning` (so the
 * next request recovers instead of failing).
 *
 * This test kills the backend behind the gateway's back - the exact scenario - and checks
 * both behaviours.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReporter, callGateway, exitWith, portOpen } from './test-util.js';

const run = promisify(execFile);
const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const { check, section, finish } = createReporter('stale state: a dead service must not look ready');

const call = (method, path, body, timeoutSec = 120) => callGateway(BASE, method, path, body, timeoutSec);

/** One resource's view from the gateway. */
async function view(resourceId) {
  const status = await call('GET', '/api/status', undefined, 60);
  return status.body.resources.find((entry) => entry.id === resourceId);
}

/**
 * Kill whatever is listening on a port, without telling the gateway.
 *
 * This is the whole point: the gateway learns about it the way it would in production - by
 * noticing, not by being told. Uses taskkill with /T (tree) so the service's children go too;
 * killing only the listener left the port bound in an earlier attempt, which made the test
 * fail for a reason that had nothing to do with the code under test.
 *
 * Waits for the port to actually close before returning. Windows does not release a listening
 * socket the instant the process dies, and asserting immediately measured the release delay
 * rather than the behaviour.
 *
 * @param {number} port - the port to vacate.
 * @param {number} timeoutMs - how long to wait for the port to free up.
 * @returns {Promise<{killed: number[], closed: boolean}>} pids and whether it freed up.
 */
async function killPortOwner(port, timeoutMs = 20_000) {
  const killed = [];
  try {
    const { stdout } = await run('powershell', [
      '-NoLogo', '-NoProfile', '-Command',
      `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue;` +
      '$c | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique | ForEach-Object {' +
      '  taskkill /F /T /PID $_ 2>&1 | Out-Null; $_ }',
    ], { timeout: 60_000, windowsHide: true });
    for (const line of String(stdout).split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) killed.push(pid);
    }
  } catch {
    // No listener, or taskkill refused; the port check below decides.
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(port, 1000))) return { killed, closed: true };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { killed, closed: false };
}

// --- 0. get the resource genuinely up --------------------------------------
section('0. start the resource so there is something to kill');
const breeze = await view('breeze');
check('breeze exists', Boolean(breeze), `enabled=${breeze?.enabled}`);
if (!breeze?.enabled) await call('POST', '/api/resources/breeze', { enabled: true });

const started = await call('POST', '/api/resources/breeze/start', undefined, 240);
check('breeze started', started.body?.ok === true, JSON.stringify(started.body?.error ?? 'ok'));

const port = started.body?.resource?.port ?? breeze?.port;
const upBefore = await view('breeze');
check('the gateway reports it ready', upBefore?.state === 'ready', `state=${upBefore?.state}`);
check('the port really is listening', await portOpen(port, 3000), `port ${port}`);

// --- 1. kill it behind the gateway's back --------------------------------
section('1. kill the backend without using the gateway');
const death = await killPortOwner(port);
check('something was listening and was killed', death.killed.length > 0,
  death.killed.length > 0 ? `pids ${death.killed.join(', ')}` : 'nothing was listening');
check('the port is closed, so this is a real death', death.closed, `port ${port}`);

// The gateway still believes it is running at this instant - that is the condition being
// tested. Asserting it makes the failure mode explicit rather than implied.
const immediately = await view('breeze');
check('the gateway has not noticed yet (state is still stale)',
  immediately?.state === 'ready' || immediately?.state === 'idle',
  `state=${immediately?.state}`);

// --- 2. the next status poll must correct it -----------------------------
section('2. /api/status corrects the stale state');
const afterPoll = await view('breeze');
check('state is no longer ready', afterPoll?.state !== 'ready', `state=${afterPoll?.state}`);
check('running is false', afterPoll?.running === false, `running=${afterPoll?.running}`);
check('the idle timer is cleared', afterPoll?.keepAliveRemainingSec === null,
  `keepAliveRemainingSec=${afterPoll?.keepAliveRemainingSec}`);
check('backendBusy is cleared too', afterPoll?.backendBusy === false,
  `backendBusy=${afterPoll?.backendBusy}`);

// --- 3. the next request recovers instead of failing ---------------------
section('3. a request after the death starts it again');
const spoke = await call('POST', '/api/speak', {
  resource: 'breeze',
  text: '测试',
  mode: 'design',
  instruction: '年轻女性',
}, 600);

check('the request succeeded rather than returning 500', spoke.status === 200,
  `status=${spoke.status}${spoke.body?.error ? `: ${String(spoke.body.error).slice(0, 110)}` : ''}`);
check('it reports who served it', spoke.body?.resource === 'breeze',
  `resource=${spoke.body?.resource}`);

const upAfter = await view('breeze');
check('the resource is ready again', upAfter?.state === 'ready' || upAfter?.state === 'busy',
  `state=${upAfter?.state}`);
check('the port is listening again', await portOpen(port, 3000), `port ${port}`);

// --- 4. the idle timer must not renew a dead service forever --------------
section('4. the idle timer clears a dead service instead of re-arming');
// This is the "refreshed every three minutes" part of the report. The timer's "activity
// unknown" branch re-armed on every expiry, and a dead service always looks unknown - so it
// renewed its own claim indefinitely and nothing ever cleared the state.
//
// A short keepAlive makes the timer fire quickly instead of waiting three minutes.
const SHORT = 6;
await call('POST', '/api/resources/breeze', { keepAliveSec: SHORT });

const restarted = await call('POST', '/api/resources/breeze/start', undefined, 240);
check('breeze restarted for the timer test', restarted.body?.ok === true,
  JSON.stringify(restarted.body?.error ?? 'ok'));

const death2 = await killPortOwner(port);
check('killed again', death2.closed, `pids ${death2.killed.join(', ') || 'none'}, port ${port}`);

// Wait past the keepAlive plus a margin. No /api/status calls in this window on purpose:
// the correction must come from the idle timer itself, not from a poll.
const waitUntil = Date.now() + (SHORT + 12) * 1000;
while (Date.now() < waitUntil) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const afterTimer = await view('breeze');
check('the idle timer cleared the dead resource', afterTimer?.state === 'idle',
  `state=${afterTimer?.state}`);
check('and no stale timer is left armed', afterTimer?.keepAliveRemainingSec === null,
  `keepAliveRemainingSec=${afterTimer?.keepAliveRemainingSec}`);

// Restore the original keepAlive for the remaining checks.
await call('POST', '/api/resources/breeze', { keepAliveSec: 180 });

// --- 5. no false release of a live service -------------------------------
section('5. a live service is not forgotten');
// The correction must only fire when the port is actually gone. A healthy resource polled
// repeatedly must keep its state, or every status poll would stop the model.
const revived = await call('POST', '/api/resources/breeze/start', undefined, 240);
check('breeze up again', revived.body?.ok === true, JSON.stringify(revived.body?.error ?? 'ok'));

const before = await view('breeze');
for (let index = 0; index < 3; index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  await call('GET', '/api/status');
}
const after = await view('breeze');
check('a live resource survives repeated status polls',
  after?.state === before?.state && (after?.state === 'ready' || after?.state === 'busy'),
  `before=${before?.state} after=${after?.state}`);

// --- 6. cleanup ----------------------------------------------------------
section('6. cleanup');
await call('POST', '/api/resources/breeze/stop', undefined, 120);
check('breeze stopped', !(await portOpen(port, 2000)), `port ${port}`);

exitWith(finish());