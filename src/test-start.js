/**
 * Verify the start button actually works, over a real cold start.
 *
 * This exists because the launch path had a bug that a passing smoke test could never
 * have caught: the smoke test only checks that a *disabled* resource refuses to start,
 * so it never exercised a real launch. The first real one reported "command timed out
 * after 120000ms" while ComfyUI was in fact up and answering - the launcher's output
 * pipe was inherited by the service it spawned, so Node never saw the launcher exit.
 *
 * The fix has two halves, and this checks both:
 *   1. command output goes to a file, so the launcher's exit is observed
 *   2. if the wait does elapse anyway, the readiness URL decides, not the wait
 *
 * Because only the second half is observable from outside when the first works, the
 * assertion is deliberately outcome-based: after a stop, a start must return ok within
 * a sane time and the port must be answering.
 */

import { createReporter, callGateway, portOpen, exitWith } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const resourceId = process.argv[2] ?? 'image';

const { check, section, finish } = createReporter();

const call = (method, path, body, timeoutSec) => callGateway(BASE, method, path, body, timeoutSec);

const status = await call('GET', '/api/status');
const resource = status.body.resources.find((entry) => entry.id === resourceId);
if (!resource) {
  console.error(`no resource "${resourceId}" in config`);
  process.exit(1);
}

console.log(`start-path test for "${resourceId}" (port ${resource.port})`);
console.log();

// --- 1. stop it, and confirm the port really closes -------------------------
console.log('1. stop');
const stopped = await call('POST', `/api/resources/${resourceId}/stop`);
check( 'stop reports ok', stopped.body?.ok === true, JSON.stringify(stopped.body?.error ?? 'ok'));
const closed = !(await portOpen(resource.port, 3000));
check( 'port released after stop', closed, `port ${resource.port}`);

// --- 2. start it, and time the whole thing ---------------------------------
console.log('2. start (cold: the service has to load its model)');
const started = Date.now();
// The start call waits for readiness inside the gateway (up to ready.timeoutSec, 180 s
// for ComfyUI), so the client deadline has to be longer than that or it would abandon a
// launch that is still legitimately coming up.
const start = await call('POST', `/api/resources/${resourceId}/start`, undefined, 240);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

check( 'start reports ok', start.body?.ok === true,
  start.body?.error ? String(start.body.error).slice(0, 120) : 'ok');
check( 'port is answering after start', await portOpen(resource.port, 3000),
  `port ${resource.port}`);
console.log(`     took ${elapsed}s`);

// The specific bug this test was written for: the launcher timed out at 120s while
// the service was already up. Anything near that boundary is suspicious.
const seconds = Number(elapsed);
check( 'start was not a launcher timeout', seconds < 110,
  `${seconds}s`);
check( 'no timeout recorded as lastError',
  !String(start.body?.resource?.lastError ?? '').includes('timed out'),
  String(start.body?.resource?.lastError ?? 'none').slice(0, 80));

// --- 3. repeat start is a no-op, not a second launch ------------------------
console.log('3. start again while already running');
const again = await call('POST', `/api/resources/${resourceId}/start`);
check( 'repeat start reports ok', again.body?.ok === true,
  JSON.stringify(again.body?.error ?? 'ok'));
check( 'repeat start did not adopt ownership wrongly',
  again.body?.resource?.state === 'ready' || again.body?.resource?.state === 'busy',
  `state=${again.body?.resource?.state}`);

// --- 4. leave it stopped so nothing idle holds the card --------------------
console.log('4. stop again (leave the machine as found)');
const finalStop = await call('POST', `/api/resources/${resourceId}/stop`);
check( 'final stop reports ok', finalStop.body?.ok === true,
  JSON.stringify(finalStop.body?.error ?? 'ok'));
check( 'port released at the end', !(await portOpen(resource.port, 3000)),
  `port ${resource.port}`);

exitWith(finish());