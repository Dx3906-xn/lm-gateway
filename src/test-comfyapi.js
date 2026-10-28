/**
 * Verify the ComfyUI-shaped API: submit a graph, get ComfyUI's answer, learn nothing about ports.
 *
 * The requirement this checks is specific - one port, no per-model endpoints, model chosen
 * by the gateway. So every assertion is made against the ComfyUI protocol only:
 *
 *   /models          what is available
 *   /object_info     which node classes are accepted
 *   POST /prompt     submit a graph, get a prompt_id back immediately
 *   GET  /history    poll until it finishes, read outputs in ComfyUI's shape
 *
 * Nothing here mentions 8188, 8189 or 8190. That is the test: if the client needs to know a
 * backend port, the design has not been met.
 *
 * Two graphs are submitted - one for the Qwen-Image workflow, one for Anima - because the
 * gateway is supposed to *infer* which model can run a graph from the classes it contains.
 * Same endpoint, same protocol, different model, decided inside the gateway.
 */

import { createReporter, callGateway, exitWith, portOpen } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';

const { check, section, finish } = createReporter('ComfyUI-shaped API: one port, models inferred');

const call = (method, path, body, timeoutSec = 120) => callGateway(BASE, method, path, body, timeoutSec);

/**
 * Poll ComfyUI's history until the execution reports completion.
 *
 * This is what a real ComfyUI client does, so the test does it the same way rather than
 * calling something gateway-specific.
 */
async function waitFor(promptId, timeoutSec = 900) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const response = await call('GET', `/history/${promptId}`, undefined, 30);
    const entry = response.body?.[promptId];
    if (entry && entry.status?.completed === true) return entry;
    if (entry && entry.status?.status_str === 'error') return entry;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

// --- 0. make sure the resources we need are switched on -------------------
// Tests that flip a switch leave state in the config file, so a run of one script can
// break another that ran later. Rather than depend on ordering, this records what it
// found, enables what it needs, and puts it back at the end. A test that silently
// depends on "some other test left this on" is a trap for whoever runs it next.
section('0. prerequisites');
const initial = await call('GET', '/api/status');
const needEnabled = initial.body.resources.filter((resource) => resource.enabled !== true);
if (needEnabled.length > 0) {
  for (const resource of needEnabled) {
    await call('POST', `/api/resources/${resource.id}`, { enabled: true });
  }
}
check('every resource is enabled for this test',
  needEnabled.length === 0 || (await call('GET', '/api/status')).body.resources
    .every((resource) => resource.enabled === true),
  needEnabled.map((resource) => resource.id).join(',') || 'all were already on');

// --- 1. discovery ----------------------------------------------------------
section('1. discovery');
const models = await call('GET', '/models');
check('/models answers', models.status === 200, `status ${models.status}`);
check('/models lists every resource',
  Array.isArray(models.body?.resources) && models.body.resources.length === 5,
  `got ${models.body?.resources?.length}`);
check('every resource has a port the gateway chose',
  models.body.resources.every((resource) => Number.isInteger(resource.port) && resource.port > 0),
  models.body.resources.map((resource) => `${resource.id}:${resource.port}`).join(' '));

const info = await call('GET', '/object_info');
check('/object_info answers', info.status === 200, `status ${info.status}`);
check('/object_info lists the classes the workflows use',
  Boolean(info.body?.KSampler && info.body?.UNETLoader),
  `${Object.keys(info.body ?? {}).length} classes`);

// --- 2. a graph the caller composed itself --------------------------------
// Deliberately written from scratch with ids that do not match any stored workflow, and with
// no save node: this is the shape a client that knows ComfyUI would send, and the gateway is
// supposed to fill in what is missing.
section('2. submit a hand-written graph (anima: generic classes)');
const animaGraph = {
  1: { class_type: 'UNETLoader', inputs: { unet_name: 'anima-turbo-v1.1.safetensors', weight_dtype: 'default' } },
  2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion' } },
  3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: 'masterpiece, 1girl, lazy, cozy room' } },
  5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: 'worst quality, watermark' } },
  6: { class_type: 'EmptySD3LatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  7: {
    class_type: 'KSampler',
    inputs: {
      model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
      seed: 4242, steps: 8, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
    },
  },
  8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
};

// Timestamped before submitting, so the client's own wall clock can be compared against
// the gateway's elapsedSec. Without that comparison a timing field can be wrong by any
// amount and still look plausible.
const clientSubmittedAt = Date.now();
const submitted = await call('POST', '/prompt', { prompt: animaGraph, client_id: 'test' }, 60);
check('POST /prompt answers with a prompt_id', typeof submitted.body?.prompt_id === 'string',
  submitted.body?.prompt_id ?? JSON.stringify(submitted.body).slice(0, 160));

const animaEntry = submitted.body?.prompt_id ? await waitFor(submitted.body.prompt_id) : null;
const clientFinishedAt = Date.now();
check('the execution completed', animaEntry?.status?.completed === true,
  animaEntry?.status?.status_str ?? 'no result');
check('the gateway picked a model without being told',
  typeof animaEntry?.resource === 'string', `resource=${animaEntry?.resource}`);
check('a model was inferred for a generic graph', Boolean(animaEntry?.resource),
  `resource=${animaEntry?.resource}`);
check('outputs are in ComfyUI shape',
  Boolean(animaEntry?.outputs) && typeof animaEntry.outputs === 'object',
  JSON.stringify(Object.keys(animaEntry?.outputs ?? {})));

const outputFiles = Object.values(animaEntry?.outputs ?? {})
  .flatMap((entry) => entry?.images ?? [])
  .map((image) => image?.filename)
  .filter(Boolean);
check('an image file was produced', outputFiles.length > 0, outputFiles.join(', '));

// Timing fields. `elapsedSec` was reported as null forever because runWorkflow did not
// return a duration and comfyapi read a field that did not exist - a field that looks like
// data but never is, which is worse than omitting it. Asserted here so it cannot regress
// silently again.
check('elapsedSec is a real number', typeof animaEntry?.elapsedSec === 'number',
  `elapsedSec=${JSON.stringify(animaEntry?.elapsedSec)}`);
check('elapsedSec is positive', (animaEntry?.elapsedSec ?? 0) > 0,
  `${animaEntry?.elapsedSec}s`);
check('generateSec is a real number', typeof animaEntry?.generateSec === 'number',
  `generateSec=${JSON.stringify(animaEntry?.generateSec)}`);
check('loadSec is a real number', typeof animaEntry?.loadSec === 'number',
  `loadSec=${JSON.stringify(animaEntry?.loadSec)}`);
check('generateSec + loadSec accounts for elapsedSec',
  Math.abs(((animaEntry?.generateSec ?? 0) + (animaEntry?.loadSec ?? 0))
    - (animaEntry?.elapsedSec ?? 0)) < 0.3,
  `${animaEntry?.generateSec} + ${animaEntry?.loadSec} vs ${animaEntry?.elapsedSec}`);
check('generateSec is not greater than elapsedSec',
  (animaEntry?.generateSec ?? 0) <= (animaEntry?.elapsedSec ?? 0),
  `generate ${animaEntry?.generateSec}s vs elapsed ${animaEntry?.elapsedSec}s`);
check('startedAt and completedAt bracket the run',
  Boolean(animaEntry?.startedAt) && Boolean(animaEntry?.completedAt)
    && Date.parse(animaEntry.completedAt) >= Date.parse(animaEntry.startedAt),
  `${animaEntry?.startedAt} -> ${animaEntry?.completedAt}`);

// elapsedSec must reflect what the caller actually waited, cold start included. Measured
// here against the client's own clock, because an earlier version started timing inside
// runWorkflow and under-reported by exactly the cold start it was supposed to show.
const clientMeasuredSec = (clientFinishedAt - clientSubmittedAt) / 1000;
check('elapsedSec matches the client\'s own measurement',
  Math.abs(clientMeasuredSec - (animaEntry?.elapsedSec ?? 0)) <= 3,
  `client ${clientMeasuredSec.toFixed(1)}s vs gateway ${animaEntry?.elapsedSec}s`);

// --- 3. a graph with Breeze nodes must not land on the image model --------
// This is the failure the inference has to avoid: submitting audio nodes to a resource whose
// workflow is for pictures would load a 6 GB model before failing on an unknown class.
section('3. graph classification is by node class, not luck');
const breezeGraph = {
  1: {
    class_type: 'BreezeTTS2LoadModel',
    inputs: { model: 'int8 hybrid (recommended)', dtype: 'auto', device: 'auto', attention: 'sdpa', decode_mode: 'eager', download_if_missing: false },
  },
  2: {
    class_type: 'BreezeTTS2VoiceDesign',
    inputs: {
      breeze_model: ['1', 0], text: '测试', instruction: '年轻女性', cfg_scale: 4.0,
      max_new_tokens: 200, temperature: 0.9, top_k: 50, top_p: 1.0, repetition_penalty: 1.1,
      depth_temperature: 0.9, depth_top_k: 50, depth_top_p: 1.0, seed: 7,
    },
  },
  9: { class_type: 'SaveAudioAdvanced', inputs: { audio: ['2', 0], filename_prefix: 'apitest', format: 'flac' } },
};
const breezeSubmitted = await call('POST', '/prompt', { prompt: breezeGraph }, 60);
check('a Breeze graph is accepted', typeof breezeSubmitted.body?.prompt_id === 'string',
  breezeSubmitted.body?.prompt_id ?? JSON.stringify(breezeSubmitted.body).slice(0, 160));

const breezeEntry = breezeSubmitted.body?.prompt_id
  ? await waitFor(breezeSubmitted.body.prompt_id, 900)
  : null;
check('it was routed to the breeze resource, not image',
  breezeEntry?.resource === 'breeze', `resource=${breezeEntry?.resource}`);
check('it completed', breezeEntry?.status?.completed === true,
  breezeEntry?.status?.status_str ?? 'no result');

// --- 4. an unrunnable graph is refused before a model loads ---------------
section('4. an unsupported graph is refused up front');
const nonsense = await call('POST', '/prompt', {
  prompt: { 1: { class_type: 'NotARealNode', inputs: {} } },
}, 30);
check('unknown node classes are rejected', nonsense.status === 400, `got ${nonsense.status}`);
check('the rejection says why', String(nonsense.body?.error ?? '').includes('node classes'),
  String(nonsense.body?.error ?? '').slice(0, 120));

// --- 5. the client never needed a backend port ---------------------------
section('5. no caller-visible backend port');
// Everything above was addressed to :8790. The proxy is still there for escape hatches, but
// it is no longer required for normal work - which is the whole point.
check('the API base is the only address used', BASE.includes('8790'), BASE);

// --- 6. put the switches back --------------------------------------------
// Restore whatever was off before this ran, so the next script does not have to guess why
// a resource it needs is disabled.
section('6. cleanup');
for (const resource of needEnabled) {
  await call('POST', `/api/resources/${resource.id}`, { enabled: false });
}
if (needEnabled.length > 0) {
  const restored = await call('GET', '/api/status');
  check('switches restored to their earlier state',
    needEnabled.every((resource) => restored.body.resources
      .find((current) => current.id === resource.id)?.enabled === false),
    needEnabled.map((resource) => resource.id).join(','));
}

exitWith(finish());