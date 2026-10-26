/**
 * Talking to ComfyUI over its HTTP API.
 *
 * Workflows are submitted in the API format (`{"1": {"class_type": ...}}`) rather
 * than the canvas format, because that is what `POST /prompt` accepts and it is the
 * form this project can generate, validate and patch programmatically.
 *
 * The `override` mechanism is how a caller customises a stored workflow without
 * editing it: node ids are keys, and their `inputs` are shallow-merged. That keeps
 * prompt injection, seed changes and step-count tweaks out of the workflow files,
 * so one file can serve many requests.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.js';
import { log } from '../log.js';

let workflowCache = null;

/**
 * Load every workflow in the workflows directory, keyed by filename.
 *
 * @param {boolean} reload - discard the cache first.
 * @returns {Map<string, object>} filename to parsed graph.
 */
export function loadWorkflows(reload = false) {
  if (workflowCache && !reload) return workflowCache;

  const found = new Map();
  if (existsSync(paths.workflows)) {
    for (const name of readdirSync(paths.workflows)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(paths.workflows, name), 'utf8'));
        found.set(name, parsed);
      } catch (error) {
        // A broken workflow must not stop the gateway from serving the others.
        log.warn(`workflow ${name} is not valid JSON`, String(error?.message ?? error).slice(0, 200));
      }
    }
  }

  workflowCache = found;
  log.info(`loaded ${found.size} workflow(s)`);
  return found;
}

/** Names of the loaded workflows, for `GET /api/workflows`. */
export function listWorkflows() {
  return [...loadWorkflows().keys()].sort();
}

/**
 * Deep-clone a stored workflow and apply two kinds of edit.
 *
 * `injection` comes from the gateway's own config - it says where a caller's prompt
 * belongs in this particular graph - and is therefore checked strictly. The check
 * exists because of a real defect found while building this: Qwen-Image's text field
 * is `prompt`, Anima's is `text`. Writing the wrong one is accepted silently by
 * ComfyUI, which ignores unknown inputs, so the run succeeds and the image ignores
 * the prompt entirely. That is the worst possible failure - it looks like it worked.
 *
 * `override` comes from the caller and is allowed to add fields, since a caller may
 * legitimately know about node inputs the config does not mention. Unknown fields are
 * reported rather than rejected.
 *
 * @param {string} name - workflow filename.
 * @param {object} [options] - the edits.
 * @param {object} [options.injection] - config-declared injection points.
 * @param {object} [options.override] - caller-supplied node overrides.
 * @returns {object} the graph to submit.
 */
export function buildWorkflow(name, { injection = {}, override = {} } = {}) {
  const stored = loadWorkflows().get(name);
  if (!stored) {
    throw new Error(`unknown workflow "${name}"; available: ${listWorkflows().join(', ') || 'none'}`);
  }

  const graph = structuredClone(stored);

  for (const [nodeId, fields] of Object.entries(injection)) {
    const node = graph[nodeId];
    if (!node) {
      throw new Error(`injection targets unknown node "${nodeId}" in ${name}`);
    }
    const known = node.inputs ?? {};
    for (const [field, value] of Object.entries(fields)) {
      if (!(field in known)) {
        throw new Error(
          `injection writes "${field}" but node "${nodeId}" (${node.class_type}) in ${name} ` +
          `has no such input; it has: ${Object.keys(known).join(', ')}. ` +
          'Set "injectByWorkflow" for this workflow in config/resources.json.',
        );
      }
      known[field] = value;
    }
  }

  for (const [nodeId, fields] of Object.entries(override)) {
    const node = graph[nodeId];
    if (!node) {
      // Silently ignoring this would make a typo look like "the setting had no
      // effect", which is a much harder bug to see than a refusal.
      throw new Error(`override targets unknown node "${nodeId}" in ${name}`);
    }
    node.inputs = { ...(node.inputs ?? {}), ...fields };
  }

  return graph;
}

/**
 * Which node in a workflow accepts a given value.
 *
 * Per-workflow entries win over the resource default, because the default can only be
 * right for the workflow it was written against - see the note on `buildWorkflow`.
 *
 * @param {object} resource - config entry.
 * @param {string} workflowName - which workflow is about to run.
 * @param {string} key - "prompt".
 * @returns {{node: string, field: string}|null} the target, or null.
 */
export function resolveInjection(resource, workflowName, key) {
  const perWorkflow = resource.injectByWorkflow?.[workflowName]?.[key];
  if (perWorkflow) return perWorkflow;
  return resource.inject?.[key] ?? null;
}

/**
 * The inputs a node declares, for diagnostics and validation.
 *
 * @param {string} name - workflow filename.
 * @param {string} nodeId - node id.
 * @returns {string[]} field names.
 */
export function nodeFields(name, nodeId) {
  const stored = loadWorkflows().get(name);
  return Object.keys(stored?.[nodeId]?.inputs ?? {});
}

/**
 * Submit a graph and return its prompt id.
 *
 * @param {string} base - ComfyUI base URL.
 * @param {object} graph - API-format workflow.
 * @returns {Promise<string>} prompt id.
 */
export async function submit(base, graph) {
  const response = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'lm-gateway' }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // /prompt rejects invalid graphs with a node-level explanation; that text is the
    // only thing that says which node was wrong, so it is surfaced verbatim.
    const detail = payload?.error
      ? `${payload.error.type ?? ''} ${payload.error.message ?? ''}`.trim()
      : JSON.stringify(payload)?.slice(0, 400);
    const nodeErrors = payload?.node_errors
      ? ` | node_errors: ${JSON.stringify(payload.node_errors).slice(0, 400)}`
      : '';
    throw new Error(`ComfyUI rejected the workflow (${response.status}): ${detail}${nodeErrors}`);
  }

  if (!payload?.prompt_id) throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(payload).slice(0, 300)}`);
  return payload.prompt_id;
}

/**
 * Collector for files produced by an execution.
 *
 * @param {object} outputs - the `outputs` map from /history.
 * @returns {{images: string[], audio: string[]}}
 */
function collectFiles(outputs) {
  const images = [];
  const audio = [];

  for (const output of Object.values(outputs ?? {})) {
    for (const image of output?.images ?? []) {
      if (image?.filename) images.push(image.filename);
    }
    for (const item of output?.audio ?? []) {
      if (typeof item === 'string') audio.push(item);
      else if (item?.filename) audio.push(item.filename);
    }
  }

  return { images, audio };
}

/**
 * Wait for a submitted prompt to finish.
 *
 * Polls `/history` rather than the websocket: it is one request per second against a
 * local server, and it survives a dropped connection without any reconnect logic.
 *
 * @param {string} base - ComfyUI base URL.
 * @param {string} promptId - from submit.
 * @param {number} timeoutSec - how long to wait.
 * @returns {Promise<{images: string[], audio: string[], raw: object}>}
 */
export async function waitForResult(base, promptId, timeoutSec = 900) {
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    const response = await fetch(`${base}/history/${promptId}`);
    if (response.ok) {
      const history = await response.json();
      const entry = history?.[promptId];
      if (entry) {
        const status = entry.status ?? {};

        if (status.status_str === 'error') {
          const failures = (status.messages ?? [])
            .filter((message) => message[0] === 'execution_error')
            .map((message) => {
              const body = message[1] ?? {};
              return `${body.node_type ?? 'node'}: ${String(body.exception_message ?? '').slice(0, 300)}`;
            });
          throw new Error(`ComfyUI execution failed: ${failures.join(' | ') || 'unknown error'}`);
        }

        const files = collectFiles(entry.outputs);
        if (files.images.length > 0 || files.audio.length > 0) {
          return { ...files, raw: entry };
        }

        // Finished with no files: a graph that saves nothing. Report it rather than
        // spinning until the timeout.
        if (status.completed === true || status.status_str === 'success') {
          return { ...files, raw: entry };
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`ComfyUI did not finish within ${timeoutSec}s (prompt ${promptId})`);
}

/**
 * Submit and wait, the shape every caller actually wants.
 *
 * @param {string} base - ComfyUI base URL.
 * @param {object} graph - API-format workflow.
 * @param {number} timeoutSec - budget.
 * @returns {Promise<{images: string[], audio: string[], promptId: string}>}
 */
export async function runWorkflow(base, graph, timeoutSec = 900) {
  const promptId = await submit(base, graph);
  const result = await waitForResult(base, promptId, timeoutSec);
  return { ...result, promptId };
}