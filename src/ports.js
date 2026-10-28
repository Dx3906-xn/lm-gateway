/**
 * Port allocation: the gateway decides which ports its backends use.
 *
 * The configuration used to carry a fixed `port` per resource, and three of them read
 * 8188. That was accurate - they drive one ComfyUI - but it meant the numbers were
 * baked into scripts, docs and callers, and a port that happened to be busy at start-up
 * was a failure the operator had to diagnose. Since every backend here accepts its port
 * as an argument (`--port` for ComfyUI, `-p` for GPT-SoVITS, `EMBED_PORT` for the
 * embedding server), nothing actually needs to be fixed.
 *
 * So the gateway picks: it scans a range, hands each resource a port it has confirmed is
 * free, and substitutes that into the start command. The scan is done by binding, not by
 * inspecting a table - a port is free if a listener can be created on it, which is the
 * only definition that matters.
 *
 * The allocated set is sticky for the lifetime of the process. Re-allocating on every
 * start would be tidier in theory and worse in practice: a resource that is stopped and
 * restarted for a different configuration should not appear to have moved, because the
 * URLs a caller is already using (through the proxy) are built from it.
 */

import { createServer } from 'node:net';
import { log } from './log.js';

/**
 * Can this port be bound right now?
 *
 * Binding is the test, not `Get-NetTCPConnection`-style inspection: the question is
 * whether a listener can be created, and that includes ports held by a process this one
 * cannot see. The probe server is closed immediately; the window where it holds the port
 * is a couple of milliseconds.
 *
 * @param {number} port - candidate port.
 * @param {string} host - address to try.
 * @returns {Promise<boolean>} whether a listener could be created.
 */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
    });
    // `exclusive` on Windows keeps another socket from sharing the port during the probe.
    probe.listen({ port, host, exclusive: true });
  });
}

/**
 * Find the first free port at or after `preferred`, within `range`.
 *
 * The preferred port is kept when possible, so a restart usually lands on the number the
 * operator already has in a log line or a bookmark. Only when it is taken does the scan
 * move on.
 *
 * @param {number} preferred - first candidate.
 * @param {object} [options] - the search.
 * @param {number} [options.span] - how many ports to try.
 * @param {string} [options.host] - bind address.
 * @returns {Promise<number|null>} a free port, or null when the range is exhausted.
 */
export async function findFreePort(preferred, { span = 64, host = '127.0.0.1' } = {}) {
  for (let offset = 0; offset < span; offset += 1) {
    const candidate = preferred + offset;
    if (candidate < 1 || candidate > 65535) break;
    if (await isPortFree(candidate, host)) return candidate;
  }
  return null;
}

/** Ports handed out in this process, so two resources never get the same one. */
const allocated = new Map();

/**
 * Assign a port to every resource that needs one.
 *
 * Resources in the same `exclusiveGroup` share a single port. That is not an optimisation -
 * it is the truth about them: image, anima and breeze are three configurations of one
 * ComfyUI process, so they must occupy the same number. Handing each its own port would
 * quietly break the guarantee that only one of them runs at a time, because three distinct
 * ports look like three independent services.
 *
 * A resource may declare `port: 0` (or omit it) to have one chosen; anything else is a
 * preference, not a guarantee - if it is taken the scan continues, because failing to start
 * over a busy port is exactly the kind of avoidable failure this is meant to remove.
 *
 * An already-allocated resource keeps its port. Restarting a service must not move it: the
 * proxy path is stable, but the port appears in log lines, in the readiness URL and in the
 * command line that is already running.
 *
 * @param {object} config - the loaded config, mutated in place.
 * @returns {Promise<Map<string, number>>} resource id to port.
 */
export async function allocatePorts(config) {
  const host = config.gateway?.host ?? '127.0.0.1';
  const span = config.gateway?.portScanSpan ?? 64;
  const base = config.gateway?.backendPortBase ?? 8188;

  /** Port already chosen for each exclusive group, so its members agree. */
  const groupPorts = new Map();

  // Seed from a previous allocation so a restart keeps every number.
  for (const [id, port] of allocated) {
    const group = config.resources[id]?.exclusiveGroup;
    if (group) groupPorts.set(group, port);
  }

  for (const [id, resource] of Object.entries(config.resources)) {
    const group = resource.exclusiveGroup;

    // A member of a group that already has a number simply takes it. This is what keeps
    // image/anima/breeze on one port instead of drifting apart.
    if (group && groupPorts.has(group)) {
      allocated.set(id, groupPorts.get(group));
      resource.port = groupPorts.get(group);
      continue;
    }

    if (allocated.has(id) && !group) {
      resource.port = allocated.get(id);
      continue;
    }

    // Honour an explicit preference, but fall back to the shared base when absent so a new
    // resource does not have to know which numbers are already in use.
    const preferred = Number.isFinite(resource.port) && resource.port > 0
      ? resource.port
      : base;

    const taken = new Set([...allocated.values(), ...groupPorts.values()]);
    let chosen = null;
    for (let offset = 0; offset < span; offset += 1) {
      const candidate = preferred + offset;
      if (candidate > 65535) break;
      if (taken.has(candidate)) continue;
      if (await isPortFree(candidate, host)) {
        chosen = candidate;
        break;
      }
    }

    if (chosen === null) {
      throw new Error(
        `no free port for resource "${id}" in ${preferred}..${preferred + span - 1}; ` +
        'raise gateway.portScanSpan or free some ports',
      );
    }

    allocated.set(id, chosen);
    resource.port = chosen;
    if (group) groupPorts.set(group, chosen);

    if (chosen !== preferred) {
      log.warn(`${id}: port ${preferred} is busy, using ${chosen}`);
    }
  }

  // A group whose first member was reached through the "already allocated" path still needs
  // its members' configs updated, which the loop above handles by reading groupPorts first.
  for (const [id, resource] of Object.entries(config.resources)) {
    if (resource.exclusiveGroup && groupPorts.has(resource.exclusiveGroup)) {
      resource.port = groupPorts.get(resource.exclusiveGroup);
      allocated.set(id, resource.port);
    }
  }

  return new Map(allocated);
}

/**
 * Substitute the allocated port into a command spec.
 *
 * Two forms are supported and both are needed: `{port}` inside an argument covers the
 * scripts, which take the number as a flag, and `{port}` inside `cmd` covers the embedding
 * server, which reads an environment variable through its command line.
 *
 * @param {object} spec - a start or stop block.
 * @param {number} port - the allocated port.
 * @returns {object} a copy with substitutions applied.
 */
export function applyPort(spec, port) {
  if (!spec) return spec;

  const substitute = (value) => (
    typeof value === 'string' ? value.replaceAll('{port}', String(port)) : value
  );

  const copy = { ...spec };
  if (Array.isArray(copy.args)) copy.args = copy.args.map(substitute);
  if (Array.isArray(copy.cmd)) copy.cmd = copy.cmd.map(substitute);
  else if (typeof copy.cmd === 'string') copy.cmd = substitute(copy.cmd);
  if (typeof copy.env === 'object' && copy.env !== null) {
    copy.env = Object.fromEntries(
      Object.entries(copy.env).map(([key, value]) => [key, substitute(value)]),
    );
  }
  return copy;
}

/**
 * The readiness URL for a resource, built from the allocated port.
 *
 * `ready.url` may still be given verbatim, but `ready.path` is the form that survives
 * dynamic ports: the host is always this machine and the port is whatever was allocated.
 *
 * @param {object} resource - a config entry.
 * @returns {string} an absolute URL.
 */
export function readyUrl(resource) {
  if (resource.ready?.url) {
    return resource.ready.url.replaceAll('{port}', String(resource.port ?? ''));
  }
  if (resource.ready?.path) {
    return `http://127.0.0.1:${resource.port}${resource.ready.path}`;
  }
  throw new Error(`resource "${resource.id ?? '?'}" has neither ready.url nor ready.path`);
}

/** The base URL a backend listens on. */
export function backendUrl(resource) {
  return `http://127.0.0.1:${resource.port}`;
}

/** Current allocation, for status output. */
export function snapshot() {
  return Object.fromEntries(allocated);
}