/**
 * What each resource can do, and which one should serve a request that did not name one.
 *
 * Why this file exists: `/api/speak` used `body.resource ?? 'tts'`. That is a hardcoded
 * default, and it fails in a specific and avoidable way - with GPT-SoVITS switched off and
 * Breeze switched on, a caller who omits `resource` gets a 409 about a resource it never
 * asked for, while a perfectly good voice resource sits behind the same endpoint. The
 * caller's question is "say this", not "use tts"; the gateway should answer the question
 * that was asked.
 *
 * The obvious repair - filter on `backend === 'gsv' || backend === 'comfy'` - is wrong, and
 * wrong in a way that only shows up later. Three resources have `backend: 'comfy'`: image,
 * anima and breeze. Two of them cannot speak at all. A filter on backend alone would offer
 * the picture models as voice candidates and then fail inside them, which is the same class
 * of bug as the hardcoded id, just better hidden.
 *
 * So capability is derived from what a resource can *actually run*, with two sources:
 *
 *   1. `capabilities: ["speak"]` in the config - an explicit declaration, honoured as-is.
 *      This is the escape hatch for anything the inference below does not cover.
 *   2. Inference from the backend and, for ComfyUI resources, from the node classes its
 *      workflows use. A ComfyUI resource can speak when it can run `BreezeTTS2*` nodes,
 *      because those are the nodes that produce audio. That is the same evidence
 *      `inferResource` uses to route a submitted graph, so a resource either can run voice
 *      work or it cannot - there is one answer, not two.
 *
 * A hardcoded id list was the alternative, and it is the thing being removed. Adding a
 * second voice engine would mean remembering to edit the list; deriving it from the classes
 * means the resource declares what it does by doing it.
 */

import { availableClasses } from './comfyapi.js';
import { getConfig } from './config.js';

/** The capabilities this gateway understands. */
export const CAPABILITIES = ['speak', 'image', 'search'];

/**
 * Node-class prefixes that mean "this ComfyUI resource produces audio".
 *
 * Breeze is the only voice backend here, and its node pack names every class `BreezeTTS2*`.
 * Matching on the prefix rather than an exact class list keeps working when the pack adds a
 * node.
 */
const VOICE_CLASS_PREFIXES = ['BreezeTTS2'];

/**
 * What can this resource do?
 *
 * @param {object} resource - a config entry.
 * @returns {Set<string>} capability names, possibly empty.
 */
export function capabilitiesOf(resource) {
  if (!resource) return new Set();

  // An explicit declaration is the whole answer. It is the documented way to describe a
  // backend this file has never heard of.
  if (Array.isArray(resource.capabilities)) {
    return new Set(resource.capabilities.filter((name) => typeof name === 'string'));
  }

  const found = new Set();

  if (resource.backend === 'gsv') {
    // GPT-SoVITS is a speech synthesis service; speaking is all it does.
    found.add('speak');
  } else if (resource.backend === 'embed') {
    // The embedding server does retrieval only.
    found.add('search');
  } else if (resource.backend === 'comfy') {
    // A ComfyUI resource can run graphs, but running a *picture* graph needs a stored
    // workflow to submit. Breeze has none - its graphs are built in code per request, and
    // they produce audio - so inferring `image` from the backend alone would offer it as a
    // picture candidate and then fail inside handleImage with "no default workflow".
    // Measured consequence of getting this wrong: `/api/image` routed to breeze, which
    // cannot draw.
    if (resource.workflow) found.add('image');

    const classes = availableClasses(resource);
    const voice = [...classes].some((name) => (
      VOICE_CLASS_PREFIXES.some((prefix) => name.startsWith(prefix))
    ));
    if (voice) found.add('speak');
  }

  return found;
}

/**
 * Pick the resource that should serve a request for a capability.
 *
 * Ordering follows the scheduler's own rule - lower `priority` wins - so the resource chosen
 * here is the one the admission logic would also prefer. Two different ideas of "best" in
 * one gateway is how you get a panel that disagrees with its own behaviour.
 *
 * A disabled resource is never chosen while an enabled one exists. When nothing enabled can
 * serve the capability, the highest-priority *capable* resource is returned anyway, so the
 * refusal names a real candidate ("resource tts is switched off") instead of a made-up
 * default. An error that says the wrong thing is worse than no preference at all.
 *
 * @param {string} capability - one of CAPABILITIES.
 * @returns {{id: string|null, reason?: string}} the chosen id, or null with a reason.
 */
export function selectForCapability(capability) {
  const config = getConfig();

  const capable = Object.entries(config.resources)
    .filter(([, resource]) => capabilitiesOf(resource).has(capability))
    .sort((a, b) => (a[1].priority ?? 0) - (b[1].priority ?? 0));

  if (capable.length === 0) {
    return {
      id: null,
      reason:
        `no configured resource can ${capability}; available capabilities: ` +
        `${describeCapabilities(config)}`,
    };
  }

  const enabled = capable.find(([, resource]) => resource.enabled === true);
  if (enabled) return { id: enabled[0] };

  // Everything capable is switched off. Hand back the first so DisabledError can say which
  // one, rather than inventing a default that may not even be capable.
  return { id: capable[0][0], allDisabled: true };
}

/**
 * A short "tts: speak, image: image, ..." summary, for error messages.
 *
 * @param {object} config - the loaded config.
 * @returns {string} one line.
 */
function describeCapabilities(config) {
  const parts = Object.entries(config.resources).map(([id, resource]) => {
    const caps = [...capabilitiesOf(resource)];
    return `${id}=${caps.length > 0 ? caps.join('+') : 'none'}`;
  });
  return parts.join(', ') || 'no resources configured';
}

/**
 * The capability map for every resource, for `GET /api/status` and `/models`.
 *
 * Declared rather than inferred in the response, because a caller debugging "why was this
 * request routed there" needs to see the same answer the router used.
 *
 * @returns {Record<string, string[]>} resource id to capabilities.
 */
export function capabilityMap() {
  const config = getConfig();
  return Object.fromEntries(
    Object.entries(config.resources).map(([id, resource]) => [id, [...capabilitiesOf(resource)]]),
  );
}