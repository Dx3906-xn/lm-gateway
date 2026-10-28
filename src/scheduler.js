/**
 * The admission decision: may this run now, and what has to go first.
 *
 * This is the part of the gateway that is not a proxy. On an 8 GB card, with models
 * that individually want 5-7 GB, several of them simply cannot be resident at once,
 * and the "obvious" answer - start what was asked for and let the driver sort it out -
 * produces exactly the failure this project exists to prevent. Measured on this
 * machine, when a model does not fit ComfyUI silently parks part of it in host memory
 * and the run dies mid-generation with a CPU/CUDA tensor mismatch, minutes in, with
 * nothing pointing at the real cause.
 *
 * So requests are serialized against a budget, and a low-priority model is stopped to
 * make room rather than being allowed to collide with a high-priority one.
 *
 * Priority numbers come from how the caller experiences latency:
 *   tts 10, memory 20, breeze 30, image 40  (video 50, deferred)
 * A conversation cannot wait 137 seconds for a picture to finish; a picture can wait
 * for a sentence.
 */

import { getConfig } from './config.js';
import { readGpu, usableMiB } from './gpu.js';
import * as lifecycle from './lifecycle.js';
import * as registry from './registry.js';
import * as ports from './ports.js';
import { log } from './log.js';

/**
 * Raised when a request is refused because a switch is off. Callers turn this into
 * HTTP 409 so the refusal is explicit rather than a timeout.
 */
export class DisabledError extends Error {
  constructor(reason, id = null) {
    super(reason === 'master'
      ? 'master switch is off; every resource is disabled'
      : `resource "${id}" is switched off`);
    this.name = 'DisabledError';
    this.reason = reason;
    this.resourceId = id;
  }
}

/** Raised when the models that could be stopped still do not free enough memory. */
export class NoRoomError extends Error {
  constructor(id, needMiB, haveMiB, considered) {
    super(
      `not enough VRAM for "${id}": needs ${needMiB} MiB, ${haveMiB} MiB usable` +
      (considered.length > 0 ? ` (already stopped: ${considered.join(', ')})` : ''),
    );
    this.name = 'NoRoomError';
    this.resourceId = id;
    this.needMiB = needMiB;
    this.haveMiB = haveMiB;
  }
}

/**
 * One serial chain for everything that touches process lifecycle.
 *
 * Two requests arriving a second apart would otherwise both observe "not running",
 * both spawn a launcher, and the second would collide with the first - or worse, both
 * would try to stop each other's service. Chaining makes the second wait and then
 * find the work already done.
 */
let chain = Promise.resolve();

function serial(work) {
  const next = chain.then(work, work);
  // Swallow rejections in the chain itself so one failure does not poison later work.
  chain = next.then(() => undefined, () => undefined);
  return next;
}

/** Requests waiting for their turn, for the WebUI queue view. */
const pending = [];
let pendingSeq = 0;

/** Insert into `pending`, ordered by priority then arrival. */
function enqueue(id, priority) {
  const ticket = { ticket: ++pendingSeq, resource: id, priority, enqueuedAt: Date.now() };
  pending.push(ticket);
  pending.sort((a, b) => a.priority - b.priority || a.ticket - b.ticket);
  return ticket;
}

function dequeue(ticket) {
  const at = pending.indexOf(ticket);
  if (at >= 0) pending.splice(at, 1);
}

/** What is waiting, for display. */
export function queueSnapshot() {
  return pending.map((ticket) => ({
    id: `q-${ticket.ticket}`,
    resource: ticket.resource,
    priority: ticket.priority,
    waitingMs: Date.now() - ticket.enqueuedAt,
  }));
}

/**
 * Free enough VRAM for a resource, stopping lower-priority models if needed.
 *
 * Only resources with a *higher* priority number are candidates: yielding a
 * higher-priority service to make room for a lower-priority one would invert the
 * ordering that exists precisely to protect interactive latency.
 *
 * @param {object} config - loaded config.
 * @param {string} id - the resource that wants room.
 * @returns {Promise<{ok: boolean, haveMiB: number, stopped: string[]}>}
 */
async function makeRoom(config, id) {
  const resource = config.resources[id];
  const stopped = [];

  let gpu = await readGpu({ fresh: true });
  if (!gpu.ok) {
    // Without a reading, assume the config's own numbers rather than refusing to
    // work. Being unable to query the driver is not a reason to be unable to start.
    log.warn('gpu query failed; admitting on configured budget', gpu.error);
    return { ok: true, haveMiB: resource.vramMiB, stopped };
  }

  const headroom = config.gpu?.headroomMiB ?? 0;
  let available = usableMiB(gpu, headroom);
  if (available >= resource.vramMiB) return { ok: true, haveMiB: available, stopped };

  const candidates = Object.keys(config.resources)
    .filter((other) => other !== id)
    .filter((other) => config.resources[other].enabled)
    .filter((other) => config.resources[other].priority > resource.priority)
    .filter((other) => {
      const state = registry.entry(other).state;
      return state === 'ready' || state === 'busy';
    })
    .sort((a, b) => config.resources[b].priority - config.resources[a].priority);

  for (const other of candidates) {
    if (available >= resource.vramMiB) break;

    const state = registry.entry(other);
    if (state.inflight > 0) {
      // In use right now. Stopping it would break a live request, and the caller of
      // *this* request would rather wait than have that happen silently.
      log.info(`not stopping ${other}: request in flight`);
      continue;
    }

    log.info(`stopping ${other} to make room for ${id}`);
    const outcome = await lifecycle.stop(other);
    if (outcome.ok) {
      registry.entry(other).yielded = true;
      registry.clearGroupActive(config.resources[other].exclusiveGroup, other);
      stopped.push(other);
      gpu = await readGpu({ fresh: true });
      available = gpu.ok ? usableMiB(gpu, headroom) : available + config.resources[other].vramMiB;
    }
  }

  return { ok: available >= resource.vramMiB, haveMiB: available, stopped };
}

/**
 * Stop everything in the same exclusive group.
 *
 * The image and Breeze resources both drive ComfyUI on port 8188 but need opposite
 * DynamicVRAM flags, so they are not merely memory-exclusive - the second one cannot
 * even reuse the process the first started.
 *
 * @param {object} config - loaded config.
 * @param {string} id - the resource about to start.
 * @returns {Promise<void>}
 */
async function clearExclusiveGroup(config, id) {
  const resource = config.resources[id];
  const group = resource.exclusiveGroup;
  if (!group) return;

  for (const [other, otherResource] of Object.entries(config.resources)) {
    if (other === id || otherResource.exclusiveGroup !== group) continue;
    const state = registry.entry(other).state;
    if (state === 'ready' || state === 'busy' || state === 'starting') {
      log.info(`stopping ${other}: shares exclusive group "${group}" with ${id}`);
      const outcome = await lifecycle.stop(other);
      if (outcome.ok) registry.clearGroupActive(group, other);
    }
  }
}

/**
 * Make sure a resource is running, then hand back.
 *
 * @param {string} id - resource id.
 * @returns {Promise<void>}
 */
async function ensureRunning(id) {
  const config = getConfig();
  const resource = config.resources[id];
  const state = registry.entry(id);

  if (state.state === 'ready' || state.state === 'busy') return;

  // Already up but unrecorded (started by hand, or before this process existed).
  // fresh: whether to launch is a decision, so a cached probe must not answer it - a
  // stale "no" would start a second copy of something already running.
  if (await lifecycle.isReachable(ports.readyUrl(resource), resource.ready?.method ?? 'GET', 5_000, { fresh: true })) {
    registry.markExternal(id);
    state.state = 'ready';
    return;
  }

  await clearExclusiveGroup(config, id);

  const room = await makeRoom(config, id);
  if (!room.ok) {
    throw new NoRoomError(id, resource.vramMiB, room.haveMiB, room.stopped);
  }

  const outcome = await lifecycle.start(id);
  if (!outcome.ok) throw new Error(outcome.error ?? `failed to start ${id}`);

  // Record which configuration this group is now serving, so the status view can
  // distinguish "image is loaded" from "breeze is loaded" on the shared port.
  registry.setGroupActive(resource.exclusiveGroup, id);
}

/**
 * Cancel a pending idle release.
 *
 * Without this, a request arriving inside the linger window would be followed by the
 * old timer firing and shutting down the server it just used - the "it worked, then
 * broke a minute later" failure.
 *
 * @param {string} id - resource id.
 */
function disarm(id) {
  const state = registry.entry(id);
  if (state.keepAliveTimer !== null) {
    clearTimeout(state.keepAliveTimer);
    state.keepAliveTimer = null;
    state.keepAliveDeadline = null;
  }
}

/**
 * Arm the idle release for a resource.
 *
 * keepAliveSec is read fresh from config every time, so a WebUI change applies to the
 * very next release without a restart:
 *   > 0  release after that many seconds
 *   = 0  release as soon as the request finishes
 *   = -1 stay resident until asked otherwise
 *
 * @param {string} id - resource id.
 */
function arm(id) {
  const config = getConfig();
  const resource = config.resources[id];
  const state = registry.entry(id);

  disarm(id);

  const seconds = resource.keepAliveSec;
  if (seconds < 0) {
    log.info(`${id} will stay resident (keepAliveSec -1)`);
    return;
  }

  state.keepAliveDeadline = Date.now() + seconds * 1000;
  log.info(`${id} will be released in ${seconds}s unless used again`);

  state.keepAliveTimer = setTimeout(() => {
    state.keepAliveTimer = null;
    state.keepAliveDeadline = null;
    // Routed through the serial chain so an idle stop cannot overlap an acquire.
    void serial(async () => {
      if (registry.entry(id).inflight > 0) return;
      const current = getConfig().resources[id];
      if (!current?.enabled) return;
      try {
        const outcome = await lifecycle.stop(id);
        if (outcome.ok) registry.clearGroupActive(current.exclusiveGroup, id);
      } catch (error) {
        log.warn(`idle stop of ${id} failed`, String(error?.message ?? error).slice(0, 200));
      }
    });
  }, Math.max(0, seconds) * 1000);

  // A timer that keeps the event loop alive would make shutdown wait for it.
  if (typeof state.keepAliveTimer.unref === 'function') state.keepAliveTimer.unref();
}

/**
 * Run a piece of work against a resource, starting it if needed.
 *
 * The switch checks happen before anything else so a disabled resource is refused
 * without spawning a process - that is the specific behaviour the requirement calls
 * out, and it is asserted in the smoke test.
 *
 * @param {string} id - resource id.
 * @param {(resource: object) => Promise<any>} work - what to run once it is up.
 * @returns {Promise<any>} whatever `work` returns.
 */
export function run(id, work) {
  const config = getConfig();

  // Cheap, synchronous refusals first: no queue slot, no side effects.
  if (!config.master?.enabled) throw new DisabledError('master');
  const resource = config.resources[id];
  if (!resource) throw new Error(`unknown resource: ${id}`);
  if (!resource.enabled) throw new DisabledError('resource', id);

  const ticket = enqueue(id, resource.priority);

  return serial(async () => {
    const state = registry.entry(id);
    disarm(id);
    state.inflight += 1;
    state.yielded = false;

    const before = state.state;
    try {
      await ensureRunning(id);
      registry.touch(id);
      state.state = 'busy';
      return await work(config.resources[id]);
    } finally {
      state.inflight -= 1;
      if (state.inflight === 0) {
        state.state = state.state === 'busy' ? 'ready' : state.state;
        arm(id);
      } else if (before === 'ready') {
        state.state = 'busy';
      }
      dequeue(ticket);
    }
  });
}

/**
 * Bring a resource up without running a request against it.
 *
 * The WebUI's start button, and it obeys the same switches as `run` - a disabled
 * resource cannot be forced up by pressing the button.
 *
 * @param {string} id - resource id.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function startResource(id) {
  const config = getConfig();
  if (!config.master?.enabled) return Promise.resolve({ ok: false, error: 'master switch is off' });
  const resource = config.resources[id];
  if (!resource) return Promise.resolve({ ok: false, error: `unknown resource: ${id}` });
  if (!resource.enabled) return Promise.resolve({ ok: false, error: `resource "${id}" is switched off` });

  return serial(async () => {
    try {
      disarm(id);
      await ensureRunning(id);
      // Still armed, so a manual start does not pin the card forever: "no resource is
      // resident by default" is the project's rule, manual start included.
      arm(id);
      return { ok: true };
    } catch (error) {
      const message = String(error?.message ?? error);
      registry.setError(id, message);
      return { ok: false, error: message };
    }
  });
}

/**
 * Stop a resource now, whoever started it.
 *
 * @param {string} id - resource id.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function stopResource(id) {
  return serial(async () => {
    disarm(id);
    try {
      const outcome = await lifecycle.stop(id, { force: true });
      if (outcome.ok) registry.clearGroupActive(getConfig().resources[id]?.exclusiveGroup, id);
      return outcome;
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

/**
 * Stop every resource.
 *
 * Used when the master switch is turned off, and at process shutdown, so the card
 * goes back rather than being held by an orphaned child.
 *
 * @returns {Promise<{stopped: string[], failed: {id: string, error: string}[]}>}
 */
export function stopAll() {
  return serial(async () => {
    const config = getConfig();
    const stopped = [];
    const failed = [];

    for (const id of Object.keys(config.resources)) {
      disarm(id);
      try {
        const outcome = await lifecycle.stop(id, { force: true });
        if (outcome.ok) {
          stopped.push(id);
          registry.clearGroupActive(config.resources[id].exclusiveGroup, id);
        } else {
          failed.push({ id, error: outcome.error ?? 'unknown' });
        }
      } catch (error) {
        failed.push({ id, error: String(error?.message ?? error) });
      }
    }

    return { stopped, failed };
  });
}

/** Cancel every idle timer, for a clean exit. */
export function disarmAll() {
  const config = getConfig();
  for (const id of Object.keys(config.resources)) {
    try {
      disarm(id);
    } catch {
      // A resource removed from config mid-flight has no runtime record; nothing to do.
    }
  }
}