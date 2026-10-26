/**
 * Loading, validating and persisting the resource configuration.
 *
 * The whole point of this file is that adding or replacing a model must not require
 * a code change. Everything the gateway knows about a service - how to start it, how
 * much VRAM it needs, how long to keep it warm - lives in `config/resources.json`,
 * and this module is the only place that reads or writes it.
 *
 * Writes are atomic (temp file then rename) because the WebUI edits this file live:
 * a crash midway through a plain write would leave the gateway unable to start, and
 * that failure mode is much worse than losing one setting change.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..');

export const paths = {
  root: projectRoot,
  config: join(projectRoot, 'config', 'resources.json'),
  workflows: join(projectRoot, 'config', 'workflows'),
  webui: join(projectRoot, 'webui'),
};

const REQUIRED_RESOURCE_FIELDS = [
  'label',
  'enabled',
  'exclusiveGroup',
  'port',
  'backend',
  'vramMiB',
  'priority',
  'keepAliveSec',
  'start',
  'stop',
  'ready',
];

/**
 * Validate one resource, returning a list of human-readable problems.
 *
 * @param {string} id - the key in `resources`.
 * @param {object} resource - its body.
 * @returns {string[]} problems; empty means valid.
 */
function validateResource(id, resource) {
  const problems = [];

  if (!resource || typeof resource !== 'object') return [`resource "${id}" is not an object`];

  for (const field of REQUIRED_RESOURCE_FIELDS) {
    if (resource[field] === undefined) problems.push(`resource "${id}" is missing "${field}"`);
  }

  if (typeof resource.enabled !== 'boolean') {
    problems.push(`resource "${id}": enabled must be boolean (the switch reads it directly)`);
  }
  if (!Number.isFinite(resource.vramMiB) || resource.vramMiB <= 0) {
    problems.push(`resource "${id}": vramMiB must be a positive number`);
  }
  if (!Number.isFinite(resource.priority)) {
    problems.push(`resource "${id}": priority must be a number (lower = served first)`);
  }
  if (!Number.isInteger(resource.keepAliveSec)) {
    problems.push(`resource "${id}": keepAliveSec must be an integer (0 = stop now, -1 = stay)`);
  }
  if (resource.keepAliveSec < -1) {
    problems.push(`resource "${id}": keepAliveSec below -1 has no meaning`);
  }
  if (!Number.isFinite(resource.port)) {
    problems.push(`resource "${id}": port must be a number`);
  }

  const hasStart = resource.start?.script || resource.start?.cmd;
  if (!hasStart) {
    problems.push(`resource "${id}": start needs either a "script" or a "cmd"`);
  }
  const hasStop = resource.stop?.script || resource.stop?.cmd || resource.stop?.url;
  if (!hasStop) {
    problems.push(`resource "${id}": stop needs "script", "cmd" or "url"`);
  }
  if (!resource.ready?.url) {
    problems.push(`resource "${id}": ready.url is required (used to wait for startup)`);
  }

  return problems;
}

/**
 * Validate the whole document.
 *
 * @param {object} document - parsed resources.json.
 * @returns {string[]} problems.
 */
export function validateConfig(document) {
  const problems = [];

  if (!document || typeof document !== 'object') return ['config root must be an object'];

  if (!document.gateway || !Number.isFinite(document.gateway.port)) {
    problems.push('gateway.port is required');
  }
  if (typeof document.master?.enabled !== 'boolean') {
    problems.push('master.enabled must be boolean');
  }
  if (document.resources === null || typeof document.resources !== 'object') {
    problems.push('resources must be an object keyed by resource id');
    return problems;
  }

  for (const [id, resource] of Object.entries(document.resources)) {
    problems.push(...validateResource(id, resource));
  }

  // Same port reached by two resources is legal only when they are in one
  // exclusive group - that is exactly the image/breeze case, where both talk to
  // ComfyUI on 8188 but with mutually exclusive startup flags.
  const byPort = new Map();
  for (const [id, resource] of Object.entries(document.resources)) {
    const key = resource?.port;
    if (!Number.isFinite(key)) continue;
    if (!byPort.has(key)) byPort.set(key, []);
    byPort.get(key).push(resource);
  }
  for (const [port, group] of byPort) {
    if (group.length < 2) continue;
    const groups = new Set(group.map((resource) => resource.exclusiveGroup));
    if (groups.size !== 1) {
      problems.push(
        `port ${port} is shared by resources in different exclusive groups - ` +
        `sharing a port means they cannot run together, so they must share a group`,
      );
    }
  }

  return problems;
}

let current = null;

/**
 * Read and validate the config. Throws on invalid, because starting with a broken
 * config means every later failure is a mystery.
 *
 * @returns {object} the parsed document.
 */
export function loadConfig() {
  if (!existsSync(paths.config)) {
    throw new Error(`config not found: ${paths.config}`);
  }

  let document;
  try {
    document = JSON.parse(readFileSync(paths.config, 'utf8'));
  } catch (error) {
    throw new Error(`config is not valid JSON: ${String(error?.message ?? error)}`);
  }

  const problems = validateConfig(document);
  if (problems.length > 0) {
    throw new Error(`config invalid:\n  - ${problems.join('\n  - ')}`);
  }

  current = document;
  return document;
}

/** The last loaded document. */
export function getConfig() {
  if (current === null) return loadConfig();
  return current;
}

/**
 * Persist the config atomically.
 *
 * Write to a sibling temp file then rename over the target: rename is atomic on
 * NTFS, so a reader either sees the old document or the new one, never a partial.
 *
 * @param {object} document - the document to write.
 */
export function saveConfig(document) {
  const problems = validateConfig(document);
  if (problems.length > 0) {
    throw new Error(`refusing to save invalid config:\n  - ${problems.join('\n  - ')}`);
  }

  mkdirSync(dirname(paths.config), { recursive: true });
  const temporary = `${paths.config}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  renameSync(temporary, paths.config);
  current = document;
}

/**
 * Apply a partial edit to one resource and persist.
 *
 * Only the fields the WebUI can change are accepted; start/stop commands are not
 * editable over HTTP, so a compromised or careless page cannot point the gateway at
 * an arbitrary executable.
 *
 * @param {string} id - resource id.
 * @param {object} patch - fields to merge (enabled, keepAliveSec, vramMiB, priority).
 * @returns {object} the updated resource.
 */
export function patchResource(id, patch) {
  const document = getConfig();
  const resource = document.resources[id];
  if (!resource) throw new Error(`unknown resource: ${id}`);

  const editable = ['enabled', 'keepAliveSec', 'vramMiB', 'priority', 'label'];
  for (const key of editable) {
    if (patch[key] !== undefined) resource[key] = patch[key];
  }

  saveConfig(document);
  return resource;
}

/** Set the master switch and persist. */
export function setMaster(enabled) {
  const document = getConfig();
  document.master.enabled = Boolean(enabled);
  saveConfig(document);
  return document.master;
}