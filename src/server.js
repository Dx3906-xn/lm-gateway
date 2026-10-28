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
import * as comfyapi from './comfyapi.js';
import { capabilitiesOf, selectForCapability, capabilityMap } from './capabilities.js';
import * as ports from './ports.js';
import * as heartbeat from './heartbeat.js';
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

  // Handlers may declare their own status (comfyapi rejects an unrunnable graph with 400,
  // which is a caller mistake, not a server fault). Honouring it keeps "you sent something
  // I cannot run" distinguishable from "I broke".
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) {
    return sendJson(response, error.status, {
      ok: false,
      error: message,
      ...(error.reason ? { reason: error.reason } : {}),
    });
  }

  log.error('request failed', message.slice(0, 300));
  return sendJson(response, 500, { ok: false, error: message });
}

/** Which backend base URL a resource talks to. Port comes from the allocator. */
function baseUrl(resource) {
  return ports.backendUrl(resource);
}

// --------------------------------------------------------------------------- //
// Control plane
// --------------------------------------------------------------------------- //

async function handleStatus() {
  const config = getConfig();
  const gpu = await readGpu();

  // Reflect reality for services that are up but were not launched by us, so the
  // status view never claims "not running" about something holding VRAM.
  //
  // Probed in parallel. Serially, one status call cost the sum of every probe, and a
  // probe that timed out was aborted mid-response - which the service sees as a client
  // disconnect and logs as an error even though it is healthy. The probe result is
  // cached briefly inside isReachable, so the WebUI's 2 s poll is not a hammer.
  //
  // One result per group, not per resource. Three resources drive ComfyUI on 8188, so a
  // successful probe there says "the port is up" for all three - reporting all three as
  // running was an impossible state (one port, one listener) and made the panel look
  // broken. The group is probed once; whichever resource the gateway actually started
  // keeps ownership, and if it started none, the port is marked up without being
  // attributed to a particular configuration.
  const probedGroups = new Map();

  await Promise.all(Object.keys(config.resources).map(async (id) => {
    const state = registry.entry(id);
    if (state.state !== 'idle') return;

    const resource = config.resources[id];
    const group = resource.exclusiveGroup;

    if (group) {
      if (!probedGroups.has(group)) {
        probedGroups.set(group, await lifecycle.isReachable(
          ports.readyUrl(resource), resource.ready?.method ?? 'GET', 3_000,
        ));
      }
      if (!probedGroups.get(group)) return;

      // The group answers. Only adopt it as this resource if nobody owns it yet;
      // otherwise a second resource in the same group would claim the same process.
      if (registry.groupActiveId(group) === null) {
        registry.setGroupActive(group, id);
        registry.markExternal(id);
        state.state = 'ready';
      }
      return;
    }

    if (await lifecycle.isReachable(ports.readyUrl(resource), resource.ready?.method ?? 'GET', 3_000)) {
      registry.markExternal(id);
      state.state = 'ready';
    }
  }));

  const resources = registry.describeAll(config);

  // Attach live backend info to running embedding services. The caller's vector cache
  // is keyed by encoder version, and without this field the only thing it can key on is
  // a constant - so replacing the embedding model would keep answering from vectors
  // built by the old one, silently.
  //
  // Two fields, not one, because a single nullable field is a trap for the caller: this
  // resource is stopped most of the time by design, so `encodeVersion` would read as
  // null on nearly every poll. A consumer keyed on it would then see the version
  // flickering between "2-maskpool" and null and conclude the encoder keeps changing -
  // which is how you make a cache invalidate permanently. So:
  //
  //   encodeVersion        what is running *now*; null when the service is not up
  //   lastKnownEncodeVersion what it was the last time we could see it; survives idle
  //
  // A caller wants lastKnown for cache keys, and encodeVersion only when it needs to be
  // certain the reading is current.
  await Promise.all(resources.map(async (entry) => {
    const resource = config.resources[entry.id];
    if (resource?.backend !== 'embed') return;

    if (entry.state === 'ready' || entry.state === 'busy') {
      const info = await embed.health(ports.backendUrl(resource));
      entry.info = info;
      // Promoted to the top level so a caller does not have to know which backend
      // produced it.
      entry.encodeVersion = info?.encodeVersion ?? null;
      if (entry.encodeVersion) rememberEncodeVersion(entry.id, entry.encodeVersion, info);
    } else {
      entry.encodeVersion = null;
    }

    const remembered = recallEncodeVersion(entry.id);
    entry.lastKnownEncodeVersion = entry.encodeVersion ?? remembered?.encodeVersion ?? null;
    // Says whether that value is live or remembered, so a caller never has to guess.
    entry.encodeVersionSource = entry.encodeVersion ? 'live' : (remembered ? 'remembered' : null);
    if (!entry.encodeVersion && remembered) {
      entry.lastKnownEncodeVersionAt = remembered.at;
    }
  }));

  // Refresh the backend-busy flag for every resource that is up. This is what tells an
  // operator (and the idle timer) the difference between "nothing is happening" and
  // "ComfyUI is 100 seconds into a 137-second image". Probed in parallel and cached by the
  // backend's own cheap endpoints; a resource that is not running is known idle without a
  // call.
  await Promise.all(resources.map(async (entry) => {
    if (entry.state !== 'ready' && entry.state !== 'busy') {
      entry.backendBusy = false;
      return;
    }
    try {
      const busy = await scheduler.refreshBackendBusy(entry.id);
      entry.backendBusy = busy === true;
    } catch {
      // Unknown stays unknown; the entry keeps its previous reading rather than claiming
      // idle, because claiming idle is what stops a working model.
    }
  }));

  // What each resource can do, so a caller can see the same answer the router uses. Without
  // it, "why did /api/speak go to breeze" is only answerable by reading the config and
  // knowing which node prefixes count as voice.
  for (const entry of resources) {
    const resource = config.resources[entry.id];
    entry.capabilities = resource ? [...capabilitiesOf(resource)] : [];
  }

  return {
    master: config.master?.enabled ?? true,
    gateway: { port: config.gateway.port, uptimeSec: Math.round(process.uptime()) },
    gpu: {
      ...gpu,
      headroomMiB: config.gpu?.headroomMiB ?? 0,
      usableMiB: gpu.ok ? usableMiB(gpu, config.gpu?.headroomMiB ?? 0) : 0,
    },
    resources,
    // Which resource each capability would route to right now, and null when nothing
    // enabled can serve it. This is the routing decision itself, not a re-derivation of it.
    routing: Object.fromEntries(
      ['speak', 'image', 'search'].map((capability) => {
        const choice = selectForCapability(capability);
        return [capability, { resource: choice.id, allDisabled: choice.allDisabled === true }];
      }),
    ),
    groups: registry.groupSnapshot(),
    queue: scheduler.queueSnapshot(),
  };
}

/**
 * The last encoder version each embedding resource reported.
 *
 * In memory on purpose: a restart means the services were restarted too, so a version
 * remembered from a previous process is not evidence about this one. Within a process it
 * is exactly what a cache key needs, because it survives the idle release that makes
 * `encodeVersion` null most of the time.
 *
 * @type {Map<string, {encodeVersion: string, info: object, at: string}>}
 */
const encodeVersionMemory = new Map();

/** Record the encoder identity we just observed. */
function rememberEncodeVersion(id, encodeVersion, info) {
  encodeVersionMemory.set(id, { encodeVersion, info, at: new Date().toISOString() });
}

/** What we last saw for this resource, if anything. */
function recallEncodeVersion(id) {
  return encodeVersionMemory.get(id) ?? null;
}

async function handleMaster(body) {
  if (typeof body.enabled !== 'boolean') throw new ValidationError('master requires boolean "enabled"');
  heartbeat.noteActivity(`POST /api/master ${body.enabled ? 'ON' : 'OFF (stopping everything)'}`);
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

/**
 * Where a backend writes the files it produces.
 *
 * Needed because the two answer shapes disagreed: `/api/image` returned bare names
 * that live under ComfyUI's output directory, while `/api/speak` returned an absolute
 * path. A caller had to know which endpoint it had called before it could open the
 * result, and the plugin consuming this gateway papered over that with a comment
 * saying it was treating "two shapes as one problem". The directory is now declared
 * per resource so both can answer the same way.
 *
 * @param {object} config - loaded config.
 * @param {object} resource - the resource that produced the file.
 * @returns {string} absolute directory.
 */
function outputDirFor(config, resource) {
  return resource.outputDir ?? config.gateway?.outputDir ?? join(paths.root, 'output');
}

/**
 * Build the uniform artifact list every producing endpoint returns.
 *
 * @param {string} dir - directory the files live in.
 * @param {string[]} names - bare filenames.
 * @param {string} type - "image" or "audio".
 * @returns {{type: string, filename: string, path: string}[]} artifacts.
 */
function artifactsFor(dir, names, type) {
  return (names ?? []).map((filename) => ({
    type,
    filename,
    path: join(dir, filename),
  }));
}

/**
 * A cheap liveness probe.
 *
 * Deliberately does not touch the backend services. Whether a model is resident is a
 * different question, answered by `/api/status`, and having every resource idle is the
 * normal state here - nothing is kept running by default. What a supervisor needs is
 * "the gateway is up, and would it serve me", which is what this answers.
 *
 * `serveable` is the field to gate on: master on and the resource enabled. A resource
 * with `enabled: false` will refuse with 409 no matter how healthy it looks.
 *
 * @returns {object} health payload.
 */
function handleHealth() {
  const config = getConfig();
  const resources = {};

  for (const [id, resource] of Object.entries(config.resources)) {
    let state = 'unknown';
    try {
      state = resource.enabled ? registry.entry(id).state : 'disabled';
    } catch {
      // A resource added to config after startup has no runtime record yet; it is
      // still reportable, just not yet tracked.
      state = 'untracked';
    }
    resources[id] = {
      enabled: resource.enabled === true,
      state,
      serveable: (config.master?.enabled ?? true) && resource.enabled === true,
    };
  }

  return {
    ok: true,
    master: config.master?.enabled ?? true,
    uptimeSec: Math.round(process.uptime()),
    resources,
  };
}

/**
 * Decide which resource serves a request.
 *
 * Naming one is always honoured - the caller knows something the gateway does not. Naming
 * none means "whoever can do this", which is the question the endpoint actually answers:
 * `/api/speak` is a request to say something, not a request to use GPT-SoVITS. The old code
 * returned a hardcoded id here, so with that resource switched off a caller got a 409 about
 * a resource it never asked for while a working voice engine sat behind the same URL.
 *
 * The capability is what decides, not the backend name - see capabilities.js for why
 * filtering on `backend === 'comfy'` would offer the picture models as voice candidates.
 *
 * @param {string|undefined} requested - `body.resource`, when given.
 * @param {string} capability - "speak", "image" or "search".
 * @returns {string} the resource id to use.
 */
function resolveResource(requested, capability) {
  if (typeof requested === 'string' && requested.length > 0) return requested;

  const choice = selectForCapability(capability);
  if (choice.id === null) {
    // Nothing can do it at all: a configuration problem, and saying so beats a 409 about
    // some default that was never asked for.
    throw new ValidationError(choice.reason ?? `no resource can ${capability}`);
  }

  if (choice.allDisabled === true) {
    // Capable resources exist but every one is switched off. Returning the best of them
    // lets the existing DisabledError name it, so the refusal keeps its real reason.
    log.warn(`no enabled resource can ${capability}; trying "${choice.id}" so the refusal names it`);
  }

  return choice.id;
}

/**
 * Check a resource can do what is about to be asked of it, and say what it can do instead.
 *
 * The old checks were per-backend (`if backend !== 'gsv'`), which produced "resource image
 * is not an embedding backend" - true, but not the sentence a caller needs when it simply
 * omitted `resource` and the router handed back the wrong thing.
 *
 * @param {string} id - the chosen resource.
 * @param {object} resource - its config entry.
 * @param {string} capability - what was asked for.
 */
function requireCapability(id, resource, capability) {
  if (capabilitiesOf(resource).has(capability)) return;
  const has = [...capabilitiesOf(resource)];
  throw new ValidationError(
    `resource "${id}" cannot ${capability}` +
    (has.length > 0 ? `; it can: ${has.join(', ')}` : '; it declares no capabilities'),
  );
}

async function handleImage(body) {
  const id = resolveResource(body.resource, 'image');
  const started = Date.now();

  return scheduler.run(id, async (resource) => {
    requireCapability(id, resource, 'image');

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
      // Which resource served this. A caller that omitted `resource` can see where its
      // request went, and a caller that named one can confirm it was honoured.
      resource: id,
      workflow: workflowName,
      promptId: result.promptId,
      // ComfyUI's own file list, kept for callers that already speak it.
      images: result.images,
      // The uniform shape: absolute path, so a caller need not know which endpoint it
      // called to know where the file is.
      artifacts: artifactsFor(outputDirFor(getConfig(), resource), result.images, 'image'),
      outputDir: outputDirFor(getConfig(), resource),
      elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
    };
  });
}

async function handleSpeak(body) {
  // No hardcoded default: whoever can speak serves it. With GPT-SoVITS off and Breeze on,
  // omitting `resource` now works instead of returning a 409 about tts.
  const id = resolveResource(body.resource, 'speak');
  const started = Date.now();

  return scheduler.run(id, async (resource) => {
    requireCapability(id, resource, 'speak');

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
        // Which resource actually served this, so a caller that omitted `resource` can see
        // where its request went. `backend` says which engine; `resource` says which entry
        // in the config, and those are not always one to one.
        resource: id,
        backend: 'gsv',
        file,
        filename: name,
        bytes: spoke.bytes.length,
        artifacts: artifactsFor(outDir, [name], 'audio'),
        outputDir: outDir,
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      };
    }

    if (resource.backend === 'comfy') {
      const graph = breeze.buildGraph(body);
      const result = await comfy.runWorkflow(baseUrl(resource), graph, body.timeoutSec ?? 900);
      const dir = outputDirFor(getConfig(), resource);
      return {
        ok: true,
        resource: id,
        backend: 'comfy',
        mode: body.mode ?? 'design',
        promptId: result.promptId,
        audio: result.audio,
        artifacts: artifactsFor(dir, result.audio, 'audio'),
        outputDir: dir,
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      };
    }

    // Reached only when the config claims a capability its backend does not implement.
    // requireCapability passed, so the declaration said "speak"; the backend disagrees.
    throw new ValidationError(
      `resource "${id}" declares "speak" but its backend "${resource.backend}" has no ` +
      'speech implementation; remove the capability or fix the backend',
    );
  });
}

async function handleSearch(body) {
  const id = resolveResource(body.resource, 'search');
  const started = Date.now();

  return scheduler.run(id, async (resource) => {
    requireCapability(id, resource, 'search');
    const base = baseUrl(resource);
    // A deadline on every call out. Without one, a service that dies mid-request
    // leaves this handler waiting on a socket that will never answer - the request
    // neither returns nor fails, and the caller has nothing to retry against.
    const timeoutSec = body.timeoutSec ?? 120;

    if (Array.isArray(body.texts)) {
      const result = await embed.embed(base, body.texts, timeoutSec);
      return {
        ok: true,
        resource: id,
        ...result,
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      };
    }

    if (body.query) {
      if (!Array.isArray(body.candidates)) {
        // Ranking needs candidates; returning an empty ranking would look like
        // "nothing matched" rather than "the request was incomplete".
        throw new ValidationError('search requires "candidates" when "query" is given');
      }
      const result = await embed.similarity(base, body.query, body.candidates, timeoutSec);
      const ranked = result.scores
        .map((score, index) => ({ index, score, text: body.candidates[index] }))
        .sort((a, b) => b.score - a.score)
        .slice(0, body.topK ?? result.scores.length);
      return {
        ok: true,
        resource: id,
        ranked,
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
      };
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
 * Forward a request to one backend service, so 8790 is the only port a caller needs.
 *
 * Why this exists: the business endpoints already spoke only to 8790, but the backend
 * services still had to listen on their own ports (8188, 9880, 9820) and a client that
 * wanted something the gateway did not wrap - ComfyUI's canvas, its object_info, a
 * specific GGUF - had to know them. Three ports on one laptop, each with its own
 * lifecycle, is exactly the coupling this project is meant to remove.
 *
 * So `/backends/<resource>/<path...>` is a thin proxy. It is NOT a second lifecycle
 * manager: admittance still goes through the scheduler, which means a switched-off
 * resource refuses here too, and registering interest still arms the idle release.
 *
 * The upstream response is streamed and the body is passed through untouched, because
 * what travels over these paths is ComfyUI's own API - anything that rewrote it would
 * have to track that API forever.
 *
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {string} resourceId - which resource to reach.
 * @param {string} rest - the path remainder, including any query string.
 */
async function proxyToBackend(request, response, resourceId, rest) {
  const config = getConfig();
  const resource = config.resources[resourceId];
  if (!resource) {
    return sendJson(response, 404, {
      ok: false,
      error: `unknown resource "${resourceId}"`,
      available: Object.keys(config.resources),
    });
  }

  // Refuse before doing any work, exactly as the business endpoints do: a switched-off
  // resource must not be reachable through the back door either.
  if (!config.master?.enabled) {
    return sendJson(response, 409, {
      ok: false,
      error: 'master switch is off; every resource is disabled',
      reason: 'master',
    });
  }
  if (!resource.enabled) {
    return sendJson(response, 409, {
      ok: false,
      error: `resource "${resourceId}" is switched off`,
      reason: 'resource',
      resource: resourceId,
    });
  }

  const target = `${ports.backendUrl(resource)}/${rest}`;
  heartbeat.noteActivity(`PROXY ${request.method} ${resourceId}/${rest.split('?')[0]}`);

  // Buffer the request body: these are JSON control payloads, not uploads, and a streamed
  // forward would need duplex handling that Node does not offer for fetch.
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

  /**
   * Read-only backend paths go straight through when the service is already up.
   *
   * Routing everything through `scheduler.run` put `/queue` and `/history` behind the same
   * serial chain as the work itself, so a status poll queued behind a running generation
   * and eventually timed out - which made the gateway unable to ask its own backend the one
   * question it needs answered ("are you busy?"). A read of state is not work: it must not
   * wait for work, must not count as "in use", and must not start a service that is down
   * (the caller can see that from the connection error).
   */
  const pathOnly = rest.split('?')[0];
  const readOnly = request.method === 'GET'
    && /^\/(queue|history|system_stats|object_info|view|models)(\/|$)/.test(pathOnly);

  if (readOnly) {
    // Tried regardless of the reported state, because the state is exactly what is in
    // doubt: a resource is `starting` while its port may already be listening, and waiting
    // for the scheduler to say "ready" put a 3-second status read behind a 20-second model
    // load - measured at 56 seconds of queueing for one `/queue` call. If nothing is
    // listening the fetch fails in milliseconds and the managed path below takes over.
    try {
      const upstream = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(5_000) });
      const payload = Buffer.from(await upstream.arrayBuffer());
      const headers = {};
      const type = upstream.headers.get('content-type');
      if (type) headers['Content-Type'] = type;
      response.writeHead(upstream.status, headers);
      response.end(payload);
      return;
    } catch {
      // Not up yet, or it died. The managed path below handles both.
    }
  }

  // Same serialization and admittance as a normal call, so the model starts on demand and
  // the idle timer is cancelled by the fact that somebody is using it.
  const started = Date.now();
  await scheduler.run(resourceId, async () => {
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        // Content-Type is forwarded because ComfyUI distinguishes JSON from form posts;
        // Host and the rest of the hop-by-hop headers are deliberately not.
        ...(request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {}),
      },
      body,
    });

    const headers = {};
    const type = upstream.headers.get('content-type');
    if (type) headers['Content-Type'] = type;

    const payload = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, headers);
    response.end(payload);

    log.info(`proxy ${request.method} /backends/${resourceId}/${rest.split('?')[0]} -> ` +
      `${upstream.status} in ${Date.now() - started}ms`);
  });

  // A proxied submission is answered long before the work is done. Re-read the backend's
  // own queue state right away so `backendBusy` is accurate from the first moment, rather
  // than only after the idle timer's next check. Without this there is a window in which
  // the resource looks idle while ComfyUI is already sampling - which is exactly when a
  // short keepAlive would have stopped it.
  if (request.method === 'POST' && /\/(prompt|queue)$/.test(rest.split('?')[0])) {
    void scheduler.refreshBackendBusy(resourceId).catch(() => {});
  }
  // Errors are deliberately not caught here: scheduler.run throws DisabledError or
  // NoRoomError, and sendError (in the caller) maps those to the same 409/503 a business
  // call would have produced. Swallowing them would make the back door behave differently
  // from the front, which is how a "switched off" resource ends up usable by anyone who
  // knows the proxy path.
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

  // `/backends/<id>/...` proxies to that resource's own port, so a caller never needs to
  // know 8188/9880/9820. Checked before the static-file branch because the proxy is not a
  // file, and before the `/api/` guard because it lives outside that prefix.
  const proxyMatch = path.match(/^\/backends\/([^/]+)\/(.*)$/);
  if (proxyMatch) {
    const rest = proxyMatch[2] + (url.search || '');
    return proxyToBackend(request, response, decodeURIComponent(proxyMatch[1]), rest);
  }

  // ComfyUI's own paths live at the root, not under `/api/`, and they are now the primary
  // interface - so the static-file branch has to let them through. Listed explicitly rather
  // than "anything that is not a file", because silently swallowing a typo as a 404 from the
  // static handler produced "not found" for `/models` the first time this was wired up.
  const COMFY_PATHS = /^\/(prompt|history|queue|interrupt|object_info|models|view|embeddings)(\/|$)/;

  // `/health` sits outside the `/api/` prefix on purpose - it is the path every
  // supervisor already tries - so it has to be let past the static-file branch rather
  // than served as a missing file.
  if (!path.startsWith('/api/') && path !== '/health' && !COMFY_PATHS.test(path)) {
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
    // Liveness. Cheap on purpose: no backend probing, so a supervisor or a caller's
    // readiness check can poll it without touching a model.
    'GET /health': () => handleHealth(),

    'GET /api/status': () => handleStatus(),
    'GET /api/gpu': () => readGpu({ fresh: true }),
    'GET /api/config': () => getConfig(),
    'GET /api/logs': () => ({ entries: log.recent() }),
    // The heartbeat is what says what the gateway was doing when it stopped; exposing it
    // over HTTP means a caller can read it without knowing the on-disk layout.
    'GET /api/heartbeat': () => heartbeat.current(),
    'GET /api/workflows': () => ({ workflows: comfy.listWorkflows() }),
    // Reloading workflows must also drop the class cache, or capability routing keeps
    // believing a resource can run nodes its file no longer contains.
    'POST /api/workflows/reload': () => {
      const names = comfy.listWorkflows(true);
      comfyapi.clearClassCache();
      return { workflows: names };
    },

    'POST /api/master': (body) => handleMaster(body),
    // Graceful stop, used by scripts/stop-gateway.ps1.
    //
    // Windows gives no usable SIGTERM to a detached process, so `Stop-Process` is a
    // terminate - which would orphan the child services and leave their VRAM stranded.
    // The response is sent before shutting down, so the caller sees an answer rather than
    // a connection reset, and the actual exit happens after this turn of the loop.
    'POST /api/shutdown': () => {
      log.info('shutdown requested over HTTP');
      setImmediate(() => {
        const { requestShutdown } = globalThis.__lmGatewayShutdown ?? {};
        if (typeof requestShutdown === 'function') requestShutdown('http');
      });
      return { ok: true, stopping: true };
    },
    'POST /api/image': (body) => handleImage(body),
    'POST /api/speak': (body) => handleSpeak(body),
    'POST /api/search': (body) => handleSearch(body),

    // --- ComfyUI's shape, which is now the primary surface ----------------
    //
    // A caller submits a graph and polls for the result, exactly as it would against
    // ComfyUI itself; the gateway reads the graph, works out which model can run it,
    // starts that model, and answers in ComfyUI's own format. See comfyapi.js.
    //
    // The `/api/*` routes above stay as thin per-model conveniences. They are no longer
    // the recommended interface, but removing them would break the two clients that
    // already use them, and that is not a reason a caller should have to rewrite anything.
    'POST /prompt': (body) => comfyapi.submitPrompt(body),
    'GET /object_info': () => comfyapi.objectInfo(),
    // Discovery includes what each resource can do, because "which of these would answer
    // /api/speak" is the question this endpoint exists to answer.
    'GET /models': () => ({
      ...comfyapi.models(),
      capabilities: capabilityMap(),
    }),
    'GET /queue': () => comfyapi.queue(),
    'POST /interrupt': () => comfyapi.interrupt(),
  };

  // ComfyUI's lookup paths take an argument, so they are matched rather than tabulated.
  const historyMatch = path.match(/^\/history(?:\/([^/]+))?$/);
  if (historyMatch && method === 'GET') {
    return sendJson(response, 200, comfyapi.history(historyMatch[1]));
  }
  const objectInfoMatch = path.match(/^\/object_info\/([^/]+)$/);
  if (objectInfoMatch && method === 'GET') {
    const all = comfyapi.objectInfo();
    const wanted = decodeURIComponent(objectInfoMatch[1]);
    if (!all[wanted]) {
      return sendJson(response, 404, { ok: false, error: `no node class "${wanted}" available here` });
    }
    return sendJson(response, 200, { [wanted]: all[wanted] });
  }

  const handler = routes[`${method} ${path}`];
  if (!handler) {
    return sendJson(response, 404, {
      ok: false,
      error: `no route for ${method} ${path}`,
      available: Object.keys(routes),
    });
  }

  const body = method === 'POST' ? await readJson(request) : {};

  // Record what is being worked on before starting it. This is what makes a silent
  // death diagnosable: the heartbeat file then says "handling POST /api/speak for tts"
  // instead of the gateway simply stopping mid-log with nothing to go on. That is
  // exactly what happened once - the log ended at "tts ready" and stderr was empty.
  const label = `${method} ${path}${body?.resource ? ` (${body.resource})` : ''}`;
  heartbeat.noteActivity(label);

  const result = await handler(body);
  heartbeat.noteActivity(`${label} -> ${response.statusCode || 200}`);
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