/**
 * Prove what the gateway actually submitted, by asking ComfyUI to repeat it.
 *
 * Reading the config tells you where a prompt *should* go; it does not tell you where
 * it went. ComfyUI keeps the submitted graph in `/history/<prompt_id>`, and the gateway
 * returns that id, so the text the model really received can be read back and compared.
 *
 * That distinction is the whole point here. The failure this guards against - injecting
 * `prompt` into a node whose widget is called `text` - succeeds silently: ComfyUI
 * ignores unknown inputs, the graph runs, and the picture comes out of the workflow's
 * default tags with nothing reporting an error. A test that only checked the gateway's
 * own configuration would pass while the images were wrong.
 *
 * Runs one image per workflow. Anima finishes in seconds; Qwen-Image takes minutes, so
 * it is opt-in.
 */

import { existsSync } from 'node:fs';
import { createReporter, callGateway, exitWith } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const COMFY = process.env.LM_COMFY_URL ?? 'http://127.0.0.1:8188';

const { check, section, finish } = createReporter('prompt delivery, verified against ComfyUI history');

/** A marker unlikely to appear in any workflow's default tags. */
const MARKER = `ZZTEST-${Date.now()}`;

/**
 * Ask ComfyUI what it was given for this prompt.
 *
 * @param {string} promptId - from the gateway's response.
 * @returns {Promise<object|null>} the submitted graph, or null.
 */
async function submittedGraph(promptId) {
  const response = await fetch(`${COMFY}/history/${promptId}`);
  if (!response.ok) return null;
  const history = await response.json();
  return history?.[promptId]?.prompt ?? null;
}

/**
 * Find every input value equal to the marker, with the node that holds it.
 *
 * @param {object} graph - a ComfyUI history entry's `prompt` (an array or object).
 * @returns {{node: string, field: string, value: string}[]} where the marker landed.
 */
function findMarker(graph) {
  const found = [];

  // ComfyUI stores history prompts as [number, nodeId, {class_type, inputs}, extra]
  // in older versions and as a plain object in newer ones; handle both.
  const nodes = Array.isArray(graph)
    ? (graph[2] && typeof graph[2] === 'object' ? graph[2] : {})
    : (graph && typeof graph === 'object' ? graph : {});

  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const [field, value] of Object.entries(node?.inputs ?? {})) {
      if (typeof value === 'string' && value.includes(MARKER)) {
        found.push({ node: nodeId, field, value });
      }
    }
  }

  return found;
}

/**
 * Run one workflow and report where the marker ended up.
 *
 * @param {string} workflow - gateway workflow filename.
 * @param {string} expectNode - node id expected to receive the prompt.
 * @param {string} expectField - field expected to receive it.
 * @param {number} timeoutSec - how long to allow.
 */
async function verify(workflow, expectNode, expectField, timeoutSec) {
  section(`workflow ${workflow} (expect node ${expectNode}.${expectField})`);

  const started = Date.now();
  const result = await callGateway(
    BASE,
    'POST',
    '/api/image',
    { workflow, prompt: MARKER, override: { 5: { seed: 987001 } } },
    timeoutSec,
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (result.status !== 200) {
    check(`${workflow}: request succeeded`, false,
      `http ${result.status}: ${JSON.stringify(result.body?.error ?? result.body).slice(0, 160)}`);
    return;
  }
  check(`${workflow}: request succeeded`, true, `${elapsed}s`);

  const promptId = result.body?.promptId;
  if (!promptId) {
    check(`${workflow}: promptId returned`, false, JSON.stringify(result.body).slice(0, 160));
    return;
  }

  // --- artifacts: one shape for every producing endpoint --------------------
  // The image endpoint used to return a bare filename while the speech endpoint
  // returned an absolute path, so a caller had to know which it had called before it
  // could open the result.
  const artifacts = result.body?.artifacts ?? [];
  check(`${workflow}: artifacts carry an absolute path`,
    artifacts.length > 0 && artifacts.every((item) => item.filename && item.path),
    JSON.stringify(artifacts.slice(0, 1)));
  check(`${workflow}: artifact paths exist on disk`,
    artifacts.length > 0 && artifacts.every((item) => existsSync(item.path)),
    artifacts.map((item) => item.path).join(', ').slice(0, 140));
  check(`${workflow}: bare names still returned for existing callers`,
    Array.isArray(result.body?.images) && result.body.images.length === artifacts.length,
    `images=${JSON.stringify(result.body?.images)}`);

  const graph = await submittedGraph(promptId);
  if (!graph) {
    check(`${workflow}: graph readable from ComfyUI history`, false, 'history had no entry');
    return;
  }
  check(`${workflow}: graph readable from ComfyUI history`, true, `promptId ${promptId}`);

  const where = findMarker(graph);
  check(`${workflow}: marker reached the model at all`, where.length > 0,
    where.length > 0 ? JSON.stringify(where.map((hit) => `${hit.node}.${hit.field}`)) : 'marker absent');

  const atExpected = where.some((hit) => hit.node === expectNode && hit.field === expectField);
  check(`${workflow}: marker landed on ${expectNode}.${expectField}`, atExpected,
    atExpected ? 'as declared' : `found at ${where.map((hit) => `${hit.node}.${hit.field}`).join(', ') || 'nowhere'}`);

  // The silent-failure case: text sitting in a field the node does not read. If the
  // marker reached the declared field, there is nothing left to report.
  const misplaced = where.filter((hit) => hit.node !== expectNode || hit.field !== expectField);
  check(`${workflow}: no marker left in an unread field`, misplaced.length === 0,
    misplaced.length === 0 ? 'none' : JSON.stringify(misplaced.map((hit) => `${hit.node}.${hit.field}`)));
}

// Anima first: it is the one with the differently-named widget, and it is fast.
await verify('anima-image.json', '4', 'text', 300);

// Qwen-Image is the same code path but a different field; run it when asked.
if (process.argv.includes('--with-qwen')) {
  await verify('qwen21-image.json', '4', 'prompt', 900);
} else {
  section('skipping qwen21-image.json (pass --with-qwen; it takes minutes)');
}

exitWith(finish());