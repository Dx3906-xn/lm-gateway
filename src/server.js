/**
 * The gateway's HTTP surface: control plane, business endpoints, and the WebUI.
 *
 * One process serves all three on one port, so there is exactly one address any
 * caller needs to know (8790). The backend service ports are implementation detail
 * and are not meant to be called directly - they are listed in docs/PORTS.md only so
 * that someone debugging can see what is running.
 *
 * Refusals are explicit rather than silent: a switched-off resource answers 409 with
 * a reason, and a request that cannot be admitted for memory answers 503. Both are
 * distinguishable from "it timed out", which is the failure mode this project exists
 * to remove.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

import { getConfig, paths, patchResource, setMaster } from './config.js';
import { readGpu, usableMiB } from './gpu.js';
import * as registry from './registry.js';
import * as scheduler from './scheduler.js';
import * as lifecycle from './lifecycle.js';
import * as comfy from './backends/comfy.js';
import * as breeze from './backends/breeze.js';
import * as gsv from './backends/gsv.js';
import * as embed from './backends/embed.js';
import { log } from './log.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * A caller mistake rather than a server fault.
 *
 * Worth its own type so a bad parameter answers 400 and not 500: when everything
 * unusual reads as "internal error", a client cannot tell a typo in its own request
 * from the gateway being broken.
 */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Read and parse a JSON request body.
 *
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<object>} parsed body, or {} when empty.
 */
async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }

  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

/**
 * Send a JSON response.
 *
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} body - payload.
 */
function sendJson(response, status, body) {
  const text = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

/** Map a thrown error onto a status code and a shape a caller can act on. */
function sendError(response, error) {
  const message = String(error?.message ?? error);

  if (error instanceof scheduler.DisabledError) {
    return sendJson(response, 409, {
      ok: false,
      error: message,
      reason: error.reason,
      resource: error.resourceId,
    });
  }
  if (error instanceof scheduler.NoRoomError) {
    return sendJson(response, 503, {
      ok: false,
      error: message,
      reason: 'no-room',
      resource: error.resourceId,
      needMiB: error.needMiB,
      haveMiB: error.haveMiB,
    });
  }
  if (error instanceof ValidationError) {
    return sendJson(response, 400, { ok: false, error: message, reason: 'bad-request' });
  }

  log.error('request failed', message.slice(0, 300));
  return sendJson(response, 500, { ok: false, error: message });
}

/** Which backend base URL a resource talks to. */
function baseUrl(resource) {
  return `http://127.0.0.1:${resource.port}`;
}

// --------------------------------------------------------------------------- //
// Control plane
// --------------------------------------------------------------------------- //

async function handleStatus() {
  const config = getConfig();
  const gpu = await readGpu();

  // Reflect reality for services that are up but were not launched by us, so the
  // status view never claims "not running" about something holding VRAM.
  for (const id of Object.keys(config.resources)) {
    const state = registry.entry(id);
    if (state.state !== 'idle') continue;
    const resource = config.resources[id];
    if (await lifecycle.isReachable(resource.ready.url, resource.ready?.method ?? 'GET', 1_500)) {
      registry.markExternal(id);
      state.state = 'ready';
    }
  }

  return {
    master: config.master?.enabled ?? true,
    gateway: { port: config.gateway.port, uptimeSec: Math.round(process.uptime()) },
    gpu: {
      ...gpu,
      headroomMiB: config.gpu?.headroomMiB ?? 0,
      usableMiB: gpu.ok ? usableMiB(gpu, config.gpu?.headroomMiB ?? 0) : 0,
    },
    resources: registry.describeAll(config),
    groups: registry.groupSnapshot(),
    queue: scheduler.queueSnapshot(),
  };
}

async function handleMaster(body) {
  if (typeof body.enabled !== 'boolean') throw new ValidationError('master requires boolean "enabled"');
  const updated = setMaster(body.enabled);

  // Turning it off must free the card now, not at the next idle timeout: a user who
  // flipped the master switch did so because they want the memory back.
  let stopped = { stopped: [], failed: [] };
  if (!body.enabled) stopped = await scheduler.stopAll();

  return { ok: true, master: updated.enabled, ...stopped };
}

async function handleResourcePatch(id, body) {
  const patch = {};
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
  if (body.keepAliveSec !== undefined) {
    const seconds = Number(body.keepAliveSec);
    if (!Number.isInteger(seconds) || seconds < -1) {
      throw new ValidationError('keepAliveSec must be an integer >= -1 (0 = release now, -1 = stay)');
    }
    patch.keepAliveSec = seconds;
  }
  if (body.vramMiB !== undefined) patch.vramMiB = Number(body.vramMiB);
  if (body.priority !== undefined) patch.priority = Number(body.priority);
  if (body.label !== undefined) patch.label = String(body.label);

  const updated = patchResource(id, patch);

  // Switching off stops the service immediately; switching on does not start it,
  // because this project does not keep anything resident by default.
  let stopped = null;
  if (body.enabled === false) stopped = await scheduler.stopResource(id);

  return { ok: true, resource: registry.describe(getConfig(), id), stopped };
}

async function handleStart(id) {
  const outcome = await scheduler.startResource(id);
  return { ...outcome, resource: registry.describe(getConfig(), id) };
}

async function handleStop(id) {
  const outcome = await scheduler.stopResource(id);
  return { ...outcome, resource: registry.describe(getConfig(), id) };
}

// --------------------------------------------------------------------------- //
// Business endpoints
// --------------------------------------------------------------------------- //

async function handleImage(body) {
  const id = body.resource ?? 'image';
  const started = Date.now();

  return scheduler.run(id, async (resource) => {
    if (resource.backend !== 'comfy') {
      throw new ValidationError(`resource "${id}" is not a ComfyUI backend; cannot generate images`);
    }

    const workflowName = body.workflow ?? resource.workflow;
    if (!workflowName) {
      throw new ValidationError(`resource "${id}" has no default workflow and none was given`);
    }

    // The prompt goes where the config says it goes for *this* workflow. The gateway
    // cannot guess which node in an arbitrary graph is the text input, and guessing
    // wrong is silent: ComfyUI ignores unknown inputs, so the run would succeed and
    // the image would ignore the prompt. See comfy.buildWorkflow.
    const injection = {};
    if (body.prompt !== undefined) {
      const target = comfy.resolveInjection(resource, workflowName, 'prompt');
      if (!target) {
        throw new ValidationError(
          `resource "${id}" declares no injection point for workflow "${workflowName}", so the ` +
          'gateway does not know where the prompt belongs; add inject or injectByWorkflow in ' +
          'config/resources.json, or pass "override" with explicit node ids',
        );
      }
      injection[target.node] = { [target.field]: body.prompt };
    }

    const graph = comfy.buildWorkflow(workflowName, { injection, override: body.override ?? {} });
    const result = await comfy.runWorkflow(baseUrl(resource), graph, body.timeoutSec ?? 900);

    return {
      ok: true,
      workflow: workflowName,
      promptId: result.promptId,
      images: result.images,
      elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
    };
  });
}

async function handleSpeak(body) {
  const id = body.resource ?? 'tts';
  const started = Date.now();

  return scheduler.run(id, async (resource) => {
    if (resource.backend === 'gsv') {
      const spoke = await gsv.speak(baseUrl(resource), body, body.timeoutSec ?? 300);

      // The audio is written next to the config so a caller gets a path it can open,
      // not just bytes it has to drain from the response.
      const { writeFile, mkdir } = await import('node:fs/promises');
      const outDir = join(paths.root, 'output', 'audio');
      await mkdir(outDir, { recursive: true });
      const name = `${body.prefix ?? 'speech'}-${Date.now()}.wav`;
      const file = join(outDir, name);
      await writeFile(file, spoke.bytes);

      return {
        ok: true,
        backend: 'gsv',
        file,
        bytes: spoke.bytes.length,
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      };
    }

    if (resource.backend === 'comfy') {
      const graph = breeze.buildGraph(body);
      const result = await comfy.runWorkflow(baseUrl(resource), graph, body.timeoutSec ?? 900);
      return {
        ok: true,
        backend: 'comfy',
        mode: body.mode ?? 'design',
        promptId: result.promptId,
        audio: result.audio,
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      };
    }

    throw new ValidationError(`resource "${id}" cannot speak (backend ${resource.backend})`);
  });
}

async function handleSearch(body) {
  const id = body.resource ?? 'memory';
  const started = Date.now();

  return scheduler.run(id, async (resource) => {
    if (resource.backend !== 'embed') {
      throw new ValidationError(`resource "${id}" is not an embedding backend`);
    }
    const base = baseUrl(resource);

    if (Array.isArray(body.texts)) {
      const result = await embed.embed(base, body.texts);
      return { ok: true, ...result, elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)) };
    }

    if (body.query) {
      if (!Array.isArray(body.candidates)) {
        // Ranking needs candidates; returning an empty ranking would look like
        // "nothing matched" rather than "the request was incomplete".
        throw new ValidationError('search requires "candidates" when "query" is given');
      }
      const result = await embed.similarity(base, body.query, body.candidates);
      const ranked = result.scores
        .map((score, index) => ({ index, score, text: body.candidates[index] }))
        .sort((a, b) => b.score - a.score)
        .slice(0, body.topK ?? result.scores.length);
      return { ok: true, ranked, elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)) };
    }

    throw new ValidationError('search requires either "texts" (embed) or "query" plus "candidates" (rank)');
  });
}

// --------------------------------------------------------------------------- //
// Routing
// --------------------------------------------------------------------------- //

/** Serve a file from webui/, refusing anything that escapes the directory. */
async function serveStatic(response, relativePath) {
  const requested = relativePath === '/' ? 'index.html' : relativePath.replace(/^\/+/, '');
  const resolved = normalize(join(paths.webui, requested));

  // Path traversal guard: the resolved path must stay inside webui/.
  if (!resolved.startsWith(normalize(paths.webui))) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }

  try {
    const file = await readFile(resolved);
    const type = resolved.endsWith('.html') ? 'text/html; charset=utf-8'
      : resolved.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : resolved.endsWith('.css') ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
}

/**
 * Dispatch one request.
 *
 * Hand-rolled rather than routed by a framework: the route table is small and fixed,
 * and keeping the dependency list empty means this gateway starts on a machine where
 * npm install may never have run.
 */
async function dispatch(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (!path.startsWith('/api/')) {
    if (method !== 'GET') {
      response.writeHead(405);
      response.end('method not allowed');
      return;
    }
    return serveStatic(response, path);
  }

  // /api/resources/:id[/action]
  const resourceMatch = path.match(/^\/api\/resources\/([^/]+)(?:\/(start|stop))?$/);
  if (resourceMatch) {
    const id = decodeURIComponent(resourceMatch[1]);
    const action = resourceMatch[2];

    if (method !== 'POST') {
      return sendJson(response, 405, { ok: false, error: 'use POST for control actions' });
    }

    const body = await readJson(request);
    if (action === 'start') return sendJson(response, 200, await handleStart(id));
    if (action === 'stop') return sendJson(response, 200, await handleStop(id));
    return sendJson(response, 200, await handleResourcePatch(id, body));
  }

  const routes = {
    'GET /api/status': () => handleStatus(),
    'GET /api/gpu': () => readGpu({ fresh: true }),
    'GET /api/config': () => getConfig(),
    'GET /api/logs': () => ({ entries: log.recent() }),
    'GET /api/workflows': () => ({ workflows: comfy.listWorkflows() }),
    'POST /api/workflows/reload': () => ({ workflows: comfy.listWorkflows(true).keys?.() ?? [] }),

    'POST /api/master': (body) => handleMaster(body),
    'POST /api/image': (body) => handleImage(body),
    'POST /api/speak': (body) => handleSpeak(body),
    'POST /api/search': (body) => handleSearch(body),
  };

  const handler = routes[`${method} ${path}`];
  if (!handler) {
    return sendJson(response, 404, {
      ok: false,
      error: `no route for ${method} ${path}`,
      available: Object.keys(routes),
    });
  }

  const body = method === 'POST' ? await readJson(request) : {};
  const result = await handler(body);
  return sendJson(response, 200, result);
}

/**
 * Start the server.
 *
 * @returns {Promise<import('node:http').Server>} the listening server.
 */
export async function startServer() {
  const config = getConfig();
  registry.sync(config);

  const server = createServer((request, response) => {
    dispatch(request, response).catch((error) => {
      try {
        sendError(response, error);
      } catch {
        // Response already started; nothing useful left to do.
      }
    });
  });

  const port = config.gateway.port;
  const host = config.gateway.host ?? '127.0.0.1';

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  log.info(`lm-gateway listening on http://${host}:${port}`);
  log.info(`webui at http://${host}:${port}/`);

  return server;
}

export { dispatch };