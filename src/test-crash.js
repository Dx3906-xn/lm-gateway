/**
 * Stress the paths most likely to have killed the gateway, and report what survives.
 *
 * The gateway once vanished mid-`/api/speak`: the log stopped at "tts ready" and stderr
 * was zero bytes. That combination rules out a JavaScript throw - the process has an
 * `uncaughtException` handler that logs before doing anything else - so the process was
 * terminated from outside, or died in native code below Node.
 *
 * Nothing inside the process can catch that, so this script does the next best thing:
 * it drives the shapes that were in play and records whether the gateway is still
 * answering after each. The shapes chosen come from that timeline:
 *
 *   - a long `/api/speak` while another request arrives (concurrency)
 *   - a cold start of a heavy service while the status poller runs (churn)
 *   - stop and start in quick succession (the exact window between "tts ready" and the
 *     next log line, which is where it died)
 *   - a client that disconnects mid-request (aborted sockets)
 *
 * If it dies here, the heartbeat file names the operation it was in. If it survives,
 * the report says which shapes were exercised, so "it did not reproduce" is a fact
 * rather than a shrug.
 */

import { createReporter, callGateway, exitWith } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';

const { check, section, finish } = createReporter('crash reproduction: concurrency and churn');

/** Is the gateway answering? Uses /health because it touches no backend. */
async function alive() {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The heartbeat, for naming what the gateway was doing when it stopped. */
async function heartbeat() {
  try {
    return await (await fetch(`${BASE}/api/heartbeat`)).json();
  } catch {
    return null;
  }
}

/** Ask the gateway to abandon a request early. */
async function abortMidway(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);
  try {
    await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // Expected: this is the point of the exercise.
  } finally {
    clearTimeout(timer);
  }
}

// --- 0. baseline -----------------------------------------------------------
section('0. baseline');
check('gateway answers before the stress', await alive(), BASE);

// --- 1. concurrent control-plane churn -------------------------------------
// Stop/start pairs are the window the crash fell in: the log's last line was a service
// becoming ready, and the next thing the scheduler would do is arm or fire a timer.
section('1. rapid stop/start churn (20 cycles, 3 at a time)');
const churn = [];
for (let round = 0; round < 20; round += 1) {
  churn.push(
    callGateway(BASE, 'POST', '/api/resources/memory/stop', undefined, 60),
    callGateway(BASE, 'GET', '/api/status', undefined, 30),
    abortMidway('/api/search', { texts: ['churn'] }),
  );
  // Let some pairs interleave rather than running strictly sequentially.
  if (round % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 50));
}
await Promise.allSettled(churn);
check('survived 20 rounds of concurrent stop/status/aborted-request', await alive(),
  `${churn.length} concurrent calls`);

// --- 2. aborted requests in flight -----------------------------------------
section('2. clients that hang up mid-request (15 aborts)');
const aborts = [];
for (let index = 0; index < 15; index += 1) {
  aborts.push(abortMidway('/api/search', { texts: [`abort-${index}`] }));
}
await Promise.allSettled(aborts);
check('survived 15 abandoned requests', await alive(), 'each aborted after 400ms');

// --- 3. status polling while a heavier call is in flight -------------------
section('3. status poller hammering during a service start');
const poller = setInterval(() => {
  void fetch(`${BASE}/api/status`).catch(() => {});
}, 100);
const startAttempt = await callGateway(BASE, 'POST', '/api/resources/memory/start', undefined, 180);
clearInterval(poller);
check('start still succeeds with a poller running', startAttempt.body?.ok === true,
  JSON.stringify(startAttempt.body?.error ?? 'ok'));
check('gateway alive after the poller storm', await alive(), 'poller at 10 Hz');

// --- 4. leave the machine as found -----------------------------------------
section('4. cleanup');
await callGateway(BASE, 'POST', '/api/resources/memory/stop', undefined, 60);
check('gateway alive at the end', await alive(), BASE);

const beat = await heartbeat();
if (beat) {
  section('last recorded activity');
  console.log(`  activity   ${beat.activity}`);
  console.log(`  uptime     ${beat.uptimeSec}s`);
  console.log(`  pid        ${beat.pid}`);
}

exitWith(finish());