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

import { createConnection } from 'node:net';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const resourceId = process.argv[2] ?? 'image';

const results = [];
/**
 * Record and print one assertion.
 *
 * `results` is closed over rather than passed in. That is deliberate: an earlier
 * version of this file declared a three-parameter function while every call site
 * passed four arguments, which shifted a string into the `passed` slot and made every
 * assertion report PASS. Closing over the array removes the mismatch entirely - a test
 * that cannot fail is worse than no test.
 */
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function portOpen(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

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
const start = await call('POST', `/api/resources/${resourceId}/start`);
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

const failed = results.filter((result) => !result.passed);
console.log();
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  process.exit(1);
}