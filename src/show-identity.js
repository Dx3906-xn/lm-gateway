/**
 * Show that every producing endpoint reports both `resource` and `backend`.
 *
 * These two answer different questions and neither can be derived from the other:
 * `backend` is the engine (comfy / gsv / embed), `resource` is the entry in the config.
 * Three resources share `backend: comfy`, so a caller that only sees `comfy` cannot tell
 * whether its request went to image, anima or breeze.
 *
 * Written as a file rather than an inline command because the request bodies are JSON and
 * shell quoting mangles them - the first attempt at this returned "request body is not valid
 * JSON" for both calls, which is exactly the failure a caller would hit too.
 */

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';

/**
 * POST one request and print the fields that identify who served it.
 *
 * @param {string} label - what is being shown.
 * @param {string} path - endpoint.
 * @param {object} body - JSON payload.
 * @param {number} timeoutMs - how long the call may take.
 */
async function probe(label, path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json();
    const served = payload.resource ?? '(missing)';
    const engine = payload.backend ?? '(missing)';
    console.log(`${label}`);
    console.log(`  status    ${response.status}`);
    console.log(`  resource  ${served}`);
    console.log(`  backend   ${engine}`);
    if (payload.workflow) console.log(`  workflow  ${payload.workflow}`);
    if (payload.mode) console.log(`  mode      ${payload.mode}`);
    if (payload.error) console.log(`  error     ${String(payload.error).slice(0, 120)}`);
    return payload;
  } catch (error) {
    console.log(`${label}`);
    console.log(`  FAILED    ${String(error?.message ?? error).slice(0, 140)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const results = [];

// Image: a fresh seed so ComfyUI does not serve it from cache and return in a second.
results.push(await probe('POST /api/image  (resource omitted)', '/api/image', {
  prompt: 'test',
  override: { 7: { seed: 100000 + (Date.now() % 800000) } },
}, 900_000));

results.push(await probe('POST /api/speak  (resource omitted)', '/api/speak', {
  text: '测试',
  mode: 'design',
  instruction: '年轻女性',
}, 900_000));

results.push(await probe('POST /api/search (resource omitted)', '/api/search', {
  texts: ['测试'],
}, 120_000));

console.log();
console.log('--- what this shows ---');
const served = results.filter(Boolean);
const comfy = served.filter((entry) => entry.backend === 'comfy');
console.log(`  ${served.length} of 3 endpoints answered`);
console.log(`  ${comfy.length} of them used backend "comfy", resources: ` +
  comfy.map((entry) => entry.resource).join(', '));
if (comfy.length > 1) {
  console.log('  -> the same backend served different resources, so `backend` alone');
  console.log('     does not identify which one answered');
}
const missing = served.filter((entry) => !entry.resource || !entry.backend);
console.log(`  endpoints missing either field: ${missing.length}`);