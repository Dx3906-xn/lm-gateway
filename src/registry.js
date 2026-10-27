/**
 * Runtime state for every resource, kept separate from the config.
 *
 * Config answers "what is this resource and how much may it use". This answers
 * "what is it doing right now". Keeping them apart matters because the WebUI edits
 * config live: if the two were one object, a settings save could clobber the fact
 * that a model is mid-startup.
 *
 * A resource that is reachable but was not started by this process still counts as
 * running. That is deliberate - the stop scripts here kill by port and process tree,
 * so they can reclaim a service a human started by hand, and reporting it as "not
 * running" would hide VRAM that the budget must account for.
 */

const STATES = ['disabled', 'idle', 'starting', 'ready', 'busy', 'stopping'];

/** @type {Map<string, object>} */
const runtime = new Map();

/**
 * Which resource currently owns each exclusive group.
 *
 * Needed because two resources can share a port while being different
 * configurations of the same process. `image` and `breeze` both drive ComfyUI on
 * 8188 with opposite DynamicVRAM flags, so a plain reachability probe marks *both*
 * as running - which is true about the port and misleading about the gateway. This
 * map records which one the gateway actually started, so the status view can say
 * "this group is currently serving image" instead of implying both are live.
 *
 * @type {Map<string, string>}
 */
const groupActive = new Map();

/** Record that a resource now owns its exclusive group. */
export function setGroupActive(group, id) {
  if (group) groupActive.set(group, id);
}

/** Release ownership, but only if this resource still holds it. */
export function clearGroupActive(group, id) {
  if (group && groupActive.get(group) === id) groupActive.delete(group);
}

/** Which resource owns a group, or null when nothing is recorded. */
export function groupActiveId(group) {
  return groupActive.get(group) ?? null;
}

/** Every group and its current owner, for diagnostics. */
export function groupSnapshot() {
  return Object.fromEntries(groupActive);
}

/**
 * Ensure every configured resource has a runtime record.
 *
 * @param {object} config - the loaded config document.
 */
export function sync(config) {
  for (const id of Object.keys(config.resources)) {
    if (!runtime.has(id)) {
      runtime.set(id, {
        state: 'idle',
        startedByUs: false,
        startedAt: null,
        lastUsedAt: null,
        lastError: null,
        keepAliveTimer: null,
        keepAliveDeadline: null,
        inflight: 0,
        // True when this resource was stopped to free VRAM for a higher-priority
        // one. A yielded resource is not restarted on its own; the next request for
        // it starts it again.
        yielded: false,
      });
    }
  }
  for (const id of [...runtime.keys()]) {
    if (!config.resources[id]) runtime.delete(id);
  }
}

/** The raw mutable record, for internals. */
export function entry(id) {
  const found = runtime.get(id);
  if (!found) throw new Error(`unknown resource: ${id}`);
  return found;
}

/**
 * Merge config fields with runtime fields for one resource.
 *
 * @param {object} config - loaded config.
 * @param {string} id - resource id.
 * @returns {object} the flat view the API returns.
 */
export function describe(config, id) {
  const resource = config.resources[id];
  const state = runtime.get(id);
  if (!resource || !state) return null;

  const owner = groupActiveId(resource.exclusiveGroup);

  return {
    id,
    label: resource.label,
    enabled: resource.enabled,
    running: state.state === 'ready' || state.state === 'busy' || state.state === 'starting',
    state: resource.enabled ? state.state : 'disabled',
    port: resource.port,
    backend: resource.backend,
    exclusiveGroup: resource.exclusiveGroup,
    // Which resource the group is currently serving, and whether that is somebody
    // else. When null, the port is up but the gateway did not start it, so which
    // configuration is loaded is unknown and the UI says so rather than guessing.
    groupActive: owner,
    blockedByGroup: owner !== null && owner !== id ? owner : null,
    vramMiB: resource.vramMiB,
    priority: resource.priority,
    keepAliveSec: resource.keepAliveSec,
    keepAliveRemainingSec: state.keepAliveDeadline === null
      ? null
      : Math.max(0, Math.round((state.keepAliveDeadline - Date.now()) / 1000)),
    startedByUs: state.startedByUs,
    startedAt: state.startedAt,
    lastUsedAt: state.lastUsedAt,
    lastError: state.lastError,
    yielded: state.yielded,
    inflight: state.inflight,
    /**
     * Whether this resource is the one currently loaded on a shared port.
     *
     * Three resources drive ComfyUI on 8188, and a port has one listener, so at most one
     * of them can be up. A readiness probe cannot tell which: it sees "something answers
     * on 8188" for all three. Without this flag the status view reported `breeze` and
     * `image` as both running at once - impossible, and exactly the kind of impossible
     * that makes an operator distrust the whole panel.
     *
     * So: `running` stays literal (the port answers), and `active` says whether this
     * resource is the one that answers there. For a resource in no shared group the two
     * agree.
     */
    active: resource.exclusiveGroup
      ? (groupActiveId(resource.exclusiveGroup) === id)
      : (state.state === 'ready' || state.state === 'busy' || state.state === 'starting'),
  };
}

/** Describe every resource, ordered by priority then id. */
export function describeAll(config) {
  return Object.keys(config.resources)
    .map((id) => describe(config, id))
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/**
 * Mark a resource as running without being started by us.
 *
 * Called when a readiness probe succeeds for something we did not launch, so the
 * status view reflects reality instead of only our own actions.
 */
export function markExternal(id) {
  const state = entry(id);
  if (state.state === 'idle') {
    state.startedByUs = false;
    state.startedAt = null;
  }
}

/** Record a failure for display. */
export function setError(id, message) {
  const state = entry(id);
  state.lastError = message === null ? null : String(message).slice(0, 500);
}

/** Note that a request just used this resource. */
export function touch(id) {
  entry(id).lastUsedAt = Date.now();
}

export { STATES };