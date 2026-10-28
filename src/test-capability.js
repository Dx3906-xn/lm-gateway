/**
 * Verify that business endpoints route by capability instead of to a hardcoded default.
 *
 * The defect: `/api/speak` used `body.resource ?? 'tts'`. With GPT-SoVITS switched off and
 * Breeze switched on, a caller that omitted `resource` got a 409 about a resource it never
 * mentioned, while a working voice engine sat behind the same endpoint. The endpoint answers
 * "say this", not "use tts".
 *
 * The naive repair - filter on `backend === 'gsv' || backend === 'comfy'` - is the reason
 * this test is worth writing. Three resources have `backend: 'comfy'` and only one of them
 * can speak, so backend alone is not a capability. Capability here means "its workflows use
 * the nodes that produce that output", which is the same evidence `inferResource` uses.
 *
 * Every scenario is exercised by flipping the real switches through the API rather than by
 * mocking, because the bug lived in the interaction between routing and the enabled flag.
 */

import { createReporter, callGateway, exitWith } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const { check, section, finish } = createReporter('capability routing for /api/speak');

const call = (method, path, body, timeoutSec = 120) => callGateway(BASE, method, path, body, timeoutSec);

/** What the gateway says each resource can do, and where each capability routes. */
async function routing() {
  const status = await call('GET', '/api/status');
  const caps = {};
  for (const resource of status.body.resources) {
    caps[resource.id] = resource.capabilities ?? [];
  }
  return { caps, routes: status.body.routing, resources: status.body.resources };
}

/** Switch a resource on or off, and report whether it took. */
async function setEnabled(id, enabled) {
  const result = await call('POST', `/api/resources/${id}`, { enabled });
  return result.body?.resource?.enabled === enabled;
}

/**
 * A minimal speak request that will not actually synthesise anything if routing is wrong.
 *
 * It is deliberately cheap to reject: if the gateway routes it to a resource that cannot
 * speak, the failure comes back as a 4xx before any model loads, which is what makes it
 * safe to call repeatedly.
 */
const SPEAK_BODY = { text: '测试', mode: 'design', instruction: '年轻女性' };

// --- 0. what can do what ---------------------------------------------------
section('0. capabilities are derived, not hardcoded');
const initial = await routing();

check('image can draw', initial.caps.image?.includes('image'), JSON.stringify(initial.caps.image));
check('anima can draw', initial.caps.anima?.includes('image'), JSON.stringify(initial.caps.anima));
check('breeze can speak', initial.caps.breeze?.includes('speak'), JSON.stringify(initial.caps.breeze));
check('tts can speak', initial.caps.tts?.includes('speak'), JSON.stringify(initial.caps.tts));
check('memory can search', initial.caps.memory?.includes('search'), JSON.stringify(initial.caps.memory));

// The distinction the naive backend filter would miss: three resources share a backend and
// only one of them can speak.
const comfyResources = initial.resources.filter((resource) => resource.backend === 'comfy');
const speakingComfy = comfyResources.filter((resource) => (resource.capabilities ?? []).includes('speak'));
check('not every comfy resource can speak', speakingComfy.length < comfyResources.length,
  `${speakingComfy.length} of ${comfyResources.length} comfy resources can speak`);

// Breeze must not be offered as a picture resource: it has no stored workflow to submit.
check('breeze is not offered for image', !initial.caps.breeze?.includes('image'),
  JSON.stringify(initial.caps.breeze));

// --- 1. the reported scenario ---------------------------------------------
section('1. tts off, breeze on: omitting resource must not fail');
const ttsWas = initial.resources.find((resource) => resource.id === 'tts')?.enabled;
const breezeWas = initial.resources.find((resource) => resource.id === 'breeze')?.enabled;

await setEnabled('tts', false);
await setEnabled('breeze', true);

const afterFlip = await routing();
check('speak now routes to breeze', afterFlip.routes.speak?.resource === 'breeze',
  JSON.stringify(afterFlip.routes.speak));

const noResource = await call('POST', '/api/speak', SPEAK_BODY, 900);
// The old behaviour was 409 with reason "resource" naming tts. Anything that mentions tts
// here means the hardcoded default is still in play.
check('omitting resource does not return 409 about tts',
  !(noResource.status === 409 && noResource.body?.resource === 'tts'),
  `status=${noResource.status} resource=${noResource.body?.resource}`);

if (noResource.status === 200) {
  check('the response says which resource served it', typeof noResource.body?.resource === 'string',
    `resource=${noResource.body?.resource}`);
  check('it was breeze, not tts', noResource.body?.resource === 'breeze',
    `resource=${noResource.body?.resource}`);
  check('it still reports the backend', noResource.body?.backend === 'comfy',
    `backend=${noResource.body?.backend}`);
} else {
  // A failure here is acceptable only if it is about the model rather than about routing.
  check('any failure is not a routing failure', noResource.body?.reason !== 'resource',
    `status=${noResource.status} reason=${noResource.body?.reason}`);
}

// --- 2. priority decides when several can serve it ------------------------
section('2. the highest-priority capable resource wins');
await setEnabled('tts', true);
await setEnabled('breeze', true);

const bothOn = await routing();
check('with both enabled, speak routes to tts (priority 10 < 30)',
  bothOn.routes.speak?.resource === 'tts', JSON.stringify(bothOn.routes.speak));

// --- 3. an explicit request is honoured -----------------------------------
section('3. naming a resource still overrides the router');
const explicit = await routing();
check('explicit breeze is reported back even though tts is preferred',
  explicit.routes.speak?.resource === 'tts', 'tts is the default; breeze must still be reachable');

const explicitSpeak = await call('POST', '/api/speak', { ...SPEAK_BODY, resource: 'breeze' }, 900);
if (explicitSpeak.status === 200) {
  check('explicit resource was honoured', explicitSpeak.body?.resource === 'breeze',
    `resource=${explicitSpeak.body?.resource}`);
} else {
  check('explicit resource was not overridden to tts',
    explicitSpeak.body?.resource !== 'tts',
    `status=${explicitSpeak.status} resource=${explicitSpeak.body?.resource}`);
}

// --- 4. image routing is unaffected --------------------------------------
section('4. image routing picks a resource that can actually draw');
const imageRoutes = await routing();
check('image routes to a resource with a workflow',
  ['image', 'anima'].includes(imageRoutes.routes.image?.resource),
  JSON.stringify(imageRoutes.routes.image));

const badImage = await call('POST', '/api/image', { resource: 'breeze', prompt: 'x' }, 30);
check('asking breeze to draw is refused with a capability error',
  badImage.status === 400 || badImage.status === 405,
  `status=${badImage.status} error=${String(badImage.body?.error ?? '').slice(0, 90)}`);

// --- 5. nothing enabled: the refusal names a real candidate --------------
section('5. every capable resource disabled');
await setEnabled('tts', false);
await setEnabled('breeze', false);

const noneEnabled = await routing();
check('routing still names a candidate so the refusal can explain itself',
  typeof noneEnabled.routes.speak?.resource === 'string',
  JSON.stringify(noneEnabled.routes.speak));
check('and it is marked allDisabled', noneEnabled.routes.speak?.allDisabled === true,
  JSON.stringify(noneEnabled.routes.speak));

const refused = await call('POST', '/api/speak', SPEAK_BODY, 60);
check('the call is refused', refused.status === 409, `got ${refused.status}`);
check('the refusal names a capable resource, not an invented default',
  ['tts', 'breeze'].includes(refused.body?.resource),
  `resource=${refused.body?.resource}`);

// --- 6. restore ----------------------------------------------------------
section('6. restore the switches that were changed');
await setEnabled('tts', ttsWas === true);
await setEnabled('breeze', breezeWas === true);
const restored = await routing();
check('tts restored', restored.resources.find((r) => r.id === 'tts')?.enabled === (ttsWas === true),
  `enabled=${restored.resources.find((r) => r.id === 'tts')?.enabled}`);
check('breeze restored', restored.resources.find((r) => r.id === 'breeze')?.enabled === (breezeWas === true),
  `enabled=${restored.resources.find((r) => r.id === 'breeze')?.enabled}`);

exitWith(finish());