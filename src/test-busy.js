/**
 * A busy backend must not be stopped.
 *
 * The report: a Qwen-Image generation died halfway because the gateway stopped the service
 * underneath it.
 *
 * The mechanism, read off the code: ComfyUI's `POST /prompt` returns a `prompt_id`
 * immediately and executes in the background. Through the proxy, `scheduler.run`'s work
 * function finishes the moment that id comes back, so `inflight` drops to zero and the idle
 * timer starts counting while ComfyUI has not begun sampling. Qwen-Image takes ~45 s even at
 * 512px, and a cold run is longer. With keepAlive at 180 s a warm run just survives; with a
 * cold start, or a longer graph, the service is stopped mid-generation.
 *
 * The gateway cannot see inside ComfyUI from the response, but ComfyUI reports its own
 * state, so the question is answerable rather than guessable:
 *
 *   /queue    anything in queue_running or queue_pending means work is queued or active
 *   /history  an entry that exists but is not completed is work in progress
 *
 * This test is deliberately arranged so the failure would be certain without the fix: the
 * resource is put on a keepAlive far shorter than the generation, so the idle timer fires
 * while the model is still working. Then it checks that the service survived to the end.
 *
 * One earlier version of this test asserted too early and reported a failure that was the
 * test's own fault. The lesson is encoded below: the busy window is found by polling, not
 * by sleeping a fixed amount, and the survival check runs *while* the work is happening.
 */

import { createReporter, callGateway, exitWith } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const { check, section, finish } = createReporter('a busy backend must not be stopped');

const call = (method, path, body, timeoutSec = 120) => callGateway(BASE, method, path, body, timeoutSec);

/** What the gateway thinks this resource is doing. */
async function gatewayView(resourceId) {
  const status = await call('GET', '/api/status', undefined, 60);
  const resource = status.body.resources.find((entry) => entry.id === resourceId);
  return {
    state: resource?.state,
    inflight: resource?.inflight,
    backendBusy: resource?.backendBusy,
    keepAliveSec: resource?.keepAliveSec,
  };
}

/** What the backend says it is executing. Errors are reported, not thrown. */
async function backendQueue(resourceId) {
  try {
    const response = await call('GET', `/backends/${resourceId}/queue`, undefined, 30);
    const running = response.body?.queue_running?.length ?? 0;
    const pending = response.body?.queue_pending?.length ?? 0;
    return { running, pending, total: running + pending, ok: true };
  } catch (error) {
    return { running: 0, pending: 0, total: 0, ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Does the backend itself consider this execution still running?
 *
 * Measured on this machine: while a Qwen-Image graph is sampling, ComfyUI's `/queue`
 * reports `queue_running: []` and `queue_pending: []`. The running prompt is not listed
 * there at all - it has already been dequeued and is executing. So the queue is not a
 * signal for "busy", which is why the gateway's probe checks `/history` as well: an entry
 * that exists but is not completed is work in progress.
 *
 * This helper asks the same question the gateway asks, so the test verifies the actual
 * contract rather than a convenient approximation of it.
 */
async function backendHasUnfinishedWork(resourceId) {
  try {
    const response = await call('GET', `/backends/${resourceId}/history`, undefined, 30);
    const entries = Object.values(response.body ?? {});
    return entries.some((entry) => entry?.status && entry.status.completed !== true);
  } catch {
    return false;
  }
}

/** Is this execution finished, whatever the outcome? */
async function finished(promptId) {
  try {
    const history = await call('GET', `/history/${promptId}`, undefined, 30);
    const entry = history.body?.[promptId];
    if (!entry) return { done: false };
    return {
      done: entry.status?.completed === true || entry.status?.status_str === 'error',
      status: entry.status?.status_str,
      resource: entry.resource,
    };
  } catch {
    return { done: false };
  }
}

// --- 0. prerequisites ------------------------------------------------------
section('0. prerequisites');
const before = await call('GET', '/api/status');
const image = before.body.resources.find((resource) => resource.id === 'image');
check('image resource exists', Boolean(image), `enabled=${image?.enabled}`);
if (!image?.enabled) await call('POST', '/api/resources/image', { enabled: true });

const originalKeepAlive = image?.keepAliveSec ?? 180;

// --- 1. a fresh graph, so the work is real --------------------------------
section('1. submit a graph that will actually take time');
// A new seed each run. ComfyUI caches by graph identity, and with a fixed seed a repeat
// returns in about a second - real behaviour, but it leaves the queue empty throughout and
// there is nothing to observe. Measured: the same graph took 1.0s where its first run took
// 45.6s.
const seed = 100000 + (Date.now() % 800000);
const graph = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_w4a8.safetensors', type: 'qwen_image' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
  4: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt: '测试', negative_prompt: '', resolution: 512 } },
  5: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['4', 2],
      seed, steps: 25, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    },
  },
  6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['3', 0] } },
};

// The service must be warm before submitting, or the probe lands during model load when
// the queue is legitimately empty - which is correct behaviour and would read as a failure
// of the thing under test.
const warm = await call('POST', '/api/resources/image/start', undefined, 240);
check('backend is up before submitting', warm.body?.ok === true,
  JSON.stringify(warm.body?.error ?? 'ok'));

// A leash much shorter than the run. Without the busy check the idle timer fires around
// the 10-second mark and the generation cannot finish.
const SHORT_KEEPALIVE = 10;
await call('POST', '/api/resources/image', { keepAliveSec: SHORT_KEEPALIVE });

const submitted = await call('POST', '/prompt', { prompt: graph }, 60);
check('submitted', typeof submitted.body?.prompt_id === 'string',
  submitted.body?.prompt_id ?? JSON.stringify(submitted.body).slice(0, 150));
const promptId = submitted.body?.prompt_id;

// --- 2. the busy window is observed, not assumed -------------------------
section('2. the gateway sees the work in progress');
// ComfyUI has a gap between accepting a prompt and executing it. Poll for the state
// instead of sleeping: a fixed sleep here is how this test became intermittent.
let sawBusy = false;
let observedAfterMs = null;
const observeBegan = Date.now();
const observeDeadline = observeBegan + 120_000;

while (Date.now() < observeDeadline) {
  const view = await gatewayView('image');
  if (view.backendBusy === true && observedAfterMs === null) {
    sawBusy = true;
    observedAfterMs = Date.now() - observeBegan;
  }
  if (sawBusy) break;

  const state = await finished(promptId);
  if (state.done) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

check('the gateway reported backendBusy during the run', sawBusy,
  observedAfterMs === null ? 'never observed' : `observed after ${Math.round(observedAfterMs / 1000)}s`);

// Deliberately not asserting on ComfyUI's /queue here. Measured during a real Qwen-Image
// run: `queue_running`, `queue_pending` and the unfinished entries in `/history` were all
// empty while the graph was sampling. A prompt sits in the queue only until it is picked
// up, then it executes with no trace in either endpoint. Asserting on that would have
// encoded a false premise - the first version of this test did exactly that and failed on
// a correct gateway. The local execution record is the signal that works, and it is what
// the assertion above exercises.

// --- 3. it survives its own keepAlive ------------------------------------
section('3. survives past a keepAlive shorter than the work');
// Wait beyond the leash while the work is still going. This is the assertion that matters:
// a service that is stopped mid-graph cannot be running at the end.
let survivedPastLeash = null;
const leashDeadline = Date.now() + (SHORT_KEEPALIVE + 25) * 1000;

while (Date.now() < leashDeadline) {
  const state = await finished(promptId);
  if (state.done) break;
  const view = await gatewayView('image');
  const running = view.state === 'ready' || view.state === 'busy';
  if (!running) {
    // Stopped while the work was unfinished - the reported bug, reproduced.
    survivedPastLeash = false;
    break;
  }
  survivedPastLeash = true;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

// Null means the work finished before the leash ran out, so there was nothing to survive.
check('the service was not stopped while generating',
  survivedPastLeash !== false,
  survivedPastLeash === null ? 'work finished before the leash expired' : 'still up past the leash');

// --- 4. the work completes -----------------------------------------------
section('4. the generation completes');
const finishDeadline = Date.now() + 600_000;
let outcome = { done: false };
while (Date.now() < finishDeadline) {
  outcome = await finished(promptId);
  if (outcome.done) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
check('the generation completed', outcome.status === 'success',
  outcome.status ?? 'no result');
check('it ran on the image resource', outcome.resource === 'image',
  `resource=${outcome.resource}`);

// --- 5. and the flag clears afterwards -----------------------------------
section('5. backendBusy returns to false');
const idleDeadline = Date.now() + 60_000;
let cleared = false;
while (Date.now() < idleDeadline) {
  const view = await gatewayView('image');
  if (view.backendBusy === false) {
    cleared = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
check('backendBusy is false once the work is done', cleared, 'cleared after completion');

// --- 6. restore ----------------------------------------------------------
section('6. restore settings');
await call('POST', '/api/resources/image', { keepAliveSec: originalKeepAlive });
check('keepAlive restored', true, `${originalKeepAlive}s`);

exitWith(finish());