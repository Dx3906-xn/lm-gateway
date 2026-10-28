/**
 * Reproduce the crash: hammer /api/status while a service is starting.
 *
 * The gateway died twice during this work, both times shortly after a start began. The
 * evidence each time was the same shape - heartbeat frozen, empty stderr, no uncaught
 * exception - and the log could not help because the launcher overwrites it on every
 * restart. This script recreates the condition and reports exactly when the gateway stops
 * answering, so the failure has a timestamp to line up against.
 *
 * Kept as a file rather than an inline command because the interesting part is the timing:
 * an inline one-liner loses the ordering of "start submitted" against "poll N failed".
 */

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const RESOURCE = process.argv[2] ?? 'memory';
const POLL_MS = Number(process.env.POLL_MS ?? 200);
const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);

const began = Date.now();
const elapsed = () => `${((Date.now() - began) / 1000).toFixed(1)}s`;

/**
 * One request with a hard timeout.
 *
 * @param {string} path - endpoint.
 * @param {object} [init] - fetch options.
 * @returns {Promise<{ok: boolean, status?: number, body?: any, error?: string}>}
 */
async function hit(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${BASE}${path}`, { signal: controller.signal, ...init });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 120); }
    return { ok: true, status: response.status, body };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

// Start the service in the background; do not wait for it. The crash happened while a start
// was in flight, so waiting would remove the condition.
console.log(`${elapsed()} submitting start for ${RESOURCE}`);
const startResult = hit(`/api/resources/${RESOURCE}/start`, { method: 'POST' });

let polls = 0;
let firstFailure = null;

while (Date.now() - began < DURATION_MS) {
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  polls += 1;

  const status = await hit('/api/status');
  if (!status.ok) {
    firstFailure = { poll: polls, at: elapsed(), error: status.error };
    console.log(`${elapsed()} poll ${polls} FAILED: ${status.error}`);
    // One failure could be a transient accept-queue overflow; a second means it is gone.
    const retry = await hit('/api/status');
    if (!retry.ok) {
      console.log(`${elapsed()} retry also failed (${retry.error}); the gateway is down`);
      break;
    }
    console.log(`${elapsed()} retry succeeded; treating the failure as transient`);
    firstFailure.transient = true;
  } else {
    const entry = status.body?.resources?.find((item) => item.id === RESOURCE);
    if (polls % 5 === 0 || polls <= 3) {
      console.log(`${elapsed()} poll ${polls} ok  state=${entry?.state}`);
    }
  }
}

const start = await startResult;
console.log(`${elapsed()} start returned: ${start.ok ? `ok=${start.body?.ok}` : start.error}`);
console.log();
console.log(`polls made:   ${polls}`);
console.log(`first failure: ${firstFailure ? `${firstFailure.at} (poll ${firstFailure.poll}) ${firstFailure.error}` : 'none'}`);
console.log(`verdict:      ${firstFailure && !firstFailure.transient ? 'GATEWAY DIED' : 'survived'}`);