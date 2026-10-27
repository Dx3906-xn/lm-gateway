/**
 * Verify the three things the WebUI report asked for.
 *
 * 1. Voice and image showed the same port. Three resources drive ComfyUI on 8188 -
 *    image, anima and breeze - and that is correct rather than a misconfiguration: a
 *    port has one listener, so those three are mutually exclusive by design. What was
 *    wrong was showing a bare "8188" three times, which reads as an error. The card now
 *    says how many share it and lists them. This asserts the data behind that: the
 *    sharing is real, it is declared, and the group is consistent.
 *
 * 2. Anima had no controls of its own. It was only a workflow of the `image` resource,
 *    so it could not be switched or started independently. It is now its own resource,
 *    which means it appears in /api/status and therefore gets a card with a switch,
 *    a start button and a keep-alive field like everything else.
 *
 * 3. Too many ports. The business endpoints already spoke only to 8790, but anything the
 *    gateway did not wrap still required the backend port. `/backends/<id>/...` proxies
 *    through, so 8790 is the only port a caller needs. The critical property is that the
 *    proxy is not a back door: a switched-off resource must refuse there too.
 */

import { createReporter, callGateway, exitWith } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';

const { check, section, finish } = createReporter('resources: shared ports, anima controls, single entry port');

const call = (method, path, body, timeoutSec = 60) => callGateway(BASE, method, path, body, timeoutSec);

async function status() {
  const result = await call('GET', '/api/status');
  return result.body;
}

// --- 1. anima is a first-class resource ------------------------------------
section('1. anima has its own resource (and therefore its own controls)');
const before = await status();
const anima = before.resources.find((resource) => resource.id === 'anima');
check('anima appears in /api/status', Boolean(anima), `ids: ${before.resources.map((r) => r.id).join(',')}`);
check('anima has its own enabled switch', typeof anima?.enabled === 'boolean', `enabled=${anima?.enabled}`);
check('anima has its own keepAlive', Number.isInteger(anima?.keepAliveSec),
  `keepAliveSec=${anima?.keepAliveSec}`);
check('anima is independently addressable', Boolean(anima?.port), `port=${anima?.port}`);

// The WebUI builds one card per entry in resources, so presence here is what gives it a
// control surface. Assert the switch is actually honoured, not just reported.
const disabled = await call('POST', '/api/resources/anima', { enabled: false });
check('anima switch takes effect', disabled.body?.resource?.enabled === false,
  `enabled=${disabled.body?.resource?.enabled}`);

const refused = await call('POST', '/api/image', { resource: 'anima', prompt: 'test' }, 30);
check('disabled anima refuses a call', refused.status === 409, `got ${refused.status}`);

await call('POST', '/api/resources/anima', { enabled: true });
check('anima switch restores', (await call('GET', '/api/status')).body.resources
  .find((resource) => resource.id === 'anima')?.enabled === true, 're-enabled');

// --- 2. shared ports are declared, not accidental --------------------------
section('2. the 8188 sharing is intentional and consistent');
const current = await status();
const byPort = new Map();
for (const resource of current.resources) {
  if (!byPort.has(resource.port)) byPort.set(resource.port, []);
  byPort.get(resource.port).push(resource);
}

const shared = [...byPort.entries()].filter(([, group]) => group.length > 1);
check('some port is shared (this is the case the report noticed)',
  shared.length > 0, shared.map(([port, group]) => `${port}: ${group.length}`).join(', '));

for (const [port, group] of shared) {
  const groups = new Set(group.map((resource) => resource.exclusiveGroup));
  check(`port ${port}: all sharers sit in one exclusive group`, groups.size === 1,
    [...groups].join(','));
  // One listener means at most one configuration can be loaded. `running` is literal
  // ("the port answers") and would be true for every sharer; `active` says which one it
  // actually is, which is the field that must not have two owners.
  const active = group.filter((resource) => resource.active === true);
  check(`port ${port}: at most one sharer is active`, active.length <= 1,
    active.map((resource) => resource.id).join(',') || 'none active');
}

// --- 3. the proxy makes 8790 the only port a caller needs -----------------
section('3. /backends/<id>/... proxies through the gateway');

// A switched-off resource must not be reachable through the proxy. This is the whole
// reason the proxy runs through the scheduler rather than straight to the socket.
await call('POST', '/api/resources/anima', { enabled: false });
const proxyRefused = await fetch(`${BASE}/backends/anima/system_stats`);
check('proxy refuses a switched-off resource', proxyRefused.status === 409,
  `got ${proxyRefused.status}`);
const refusedBody = await proxyRefused.json().catch(() => null);
check('refusal names the reason', refusedBody?.reason === 'resource',
  `reason=${refusedBody?.reason}`);
await call('POST', '/api/resources/anima', { enabled: true });

const unknown = await fetch(`${BASE}/backends/nosuchresource/system_stats`);
check('proxy rejects an unknown resource', unknown.status === 404, `got ${unknown.status}`);

// A real forward: this starts ComfyUI if it is down, which is the point - the caller did
// not have to know 8188 existed or that the model needed starting.
section('4. a real forward through the proxy (starts the backend if needed)');
const startedAt = Date.now();
const proxied = await fetch(`${BASE}/backends/anima/system_stats`, { signal: AbortSignal.timeout(240_000) });
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
check('proxy returns 200', proxied.status === 200, `${elapsed}s`);
const stats = await proxied.json().catch(() => null);
check('body is passed through untouched', Boolean(stats?.system?.comfyui_version),
  `comfyui ${stats?.system?.comfyui_version}`);

const objectInfo = await fetch(`${BASE}/backends/anima/object_info/KSampler`, { signal: AbortSignal.timeout(60_000) });
check('nested paths work too', objectInfo.status === 200, `got ${objectInfo.status}`);
const info = await objectInfo.json().catch(() => null);
check('object_info parsed', Boolean(info?.KSampler), 'KSampler present');

// Using the proxy must count as use, or the model would be freed while it is in service.
section('5. proxy use resets the idle timer');
const after = await status();
const animaAfter = after.resources.find((resource) => resource.id === 'anima');
check('anima is running after the proxy call',
  animaAfter?.state === 'ready' || animaAfter?.state === 'busy', `state=${animaAfter?.state}`);
check('anima has a fresh idle timer', animaAfter?.keepAliveRemainingSec > 0,
  `${animaAfter?.keepAliveRemainingSec}s`);

// --- 6. leave it stopped ---------------------------------------------------
section('6. cleanup');
await call('POST', '/api/resources/anima/stop', undefined, 90);

exitWith(finish());