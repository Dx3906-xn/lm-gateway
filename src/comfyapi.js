/**
 * A ComfyUI-shaped API on top of everything behind the gateway.
 *
 * The reason this exists is that there is exactly one kind of client here: something that
 * already knows how to talk to ComfyUI. Reimplementing that surface per model - a `/speak`
 * endpoint, an `/api/image` endpoint, a `/embed` endpoint - means every caller learns a
 * different dialect for the same job, and the gateway has to keep those dialects working
 * forever. ComfyUI's own protocol is already that dialect: submit a graph to `/prompt`,
 * poll `/history/<id>`, read `/object_info` to discover what nodes exist.
 *
 * So the gateway speaks it. A caller submits a graph; the gateway reads the graph, decides
 * which model it needs from the node types it contains, starts that service if necessary,
 * runs it, and reports the result in ComfyUI's own response shape. Nothing on the calling
 * side knows that image/anima/breeze/tts/memory are different processes - which is the
 * requirement: one port, no per-model endpoints, and model selection inferred rather than
 * configured by the caller.
 *
 * What makes the inference possible is that each backend is addressed by a *workflow*. A
 * submitted graph is matched against the stored workflows by its node types, and the
 * resource whose workflow has the same shape is the one that can run it.
 *
 * This is a compatibility layer, not a full ComfyUI reimplementation. The endpoints below
 * are the ones a client actually uses to submit and collect work; anything else is
 * available through `/backends/<id>/...` for callers that need the real server.
 */

import { randomUUID } from 'node:crypto';

import { getConfig } from './config.js';
import * as comfy from './backends/comfy.js';
import * as scheduler from './scheduler.js';
import * as heartbeat from './heartbeat.js';
import * as ports from './ports.js';
import { log } from './log.js';

/** Executions the gateway is running, in ComfyUI's `/history` shape. */
const executions = new Map();

/** Delete finished entries after a while; a long-lived gateway must not grow forever. */
const RETENTION_MS = 60 * 60 * 1000;

/**
 * Which node classes a resource can actually run.
 *
 * Two sources, because a resource may be either kind:
 *
 *   `workflow`   a stored JSON graph; its classes are read straight out of it
 *   `classes`    a list, for resources whose graph is built in code rather than stored
 *
 * The second exists because Breeze is exactly that: its graphs are assembled per request by
 * backends/breeze.js, so there is no file to introspect. Without the explicit list the
 * gateway would refuse every Breeze graph with "no configured model can run this", which is
 * what happened the first time this was wired up.
 *
 * @param {object} resource - a config entry.
 * @returns {Set<string>} class types.
 */
function availableClasses(resource) {
  const classes = new Set(Array.isArray(resource.classes) ? resource.classes : []);

  if (resource.workflow) {
    try {
      const stored = comfy.buildWorkflow(resource.workflow, {});
      for (const node of Object.values(stored)) {
        if (node?.class_type) classes.add(node.class_type);
      }
    } catch {
      // A missing or broken workflow is not fatal here: the resource simply contributes no
      // classes, and inference will not route to it.
    }
  }

  return classes;
}

/**
 * Which resource can run this graph?
 *
 * Matched on node types rather than on node ids or filenames: a caller composing its own
 * graph will not use the same ids we do, but it will use the same classes, because those
 * are ComfyUI's. The resource whose workflow has the same set of class types is the one
 * built for that kind of work.
 *
 * Ties break on the number of type mismatches, then on priority, so a graph containing
 * `BreezeTTS2*` nodes cannot land on the image resource even if the sets happen to be
 * similar in size.
 *
 * @param {object} graph - an API-format graph, {"1": {class_type, inputs}, ...}.
 * @returns {{id: string, resource: object, score: number}|null} the best match.
 */
export function inferResource(graph) {
  const config = getConfig();
  const wanted = new Set(
    Object.values(graph ?? {})
      .map((node) => node?.class_type)
      .filter((type) => typeof type === 'string'),
  );

  if (wanted.size === 0) return null;

  const candidates = [];

  for (const [id, resource] of Object.entries(config.resources)) {
    // Only ComfyUI-backed resources can be addressed this way: a graph is a ComfyUI
    // concept, and pretending GPT-SoVITS accepts one would be a lie about what runs.
    if (resource.backend !== 'comfy') continue;

    const available = availableClasses(resource);
    if (available.size === 0) continue;

    // Every class the caller used must exist in this resource's workflow, otherwise this
    // resource cannot run the graph at all. That is a hard filter, not a score: running a
    // graph with a class the backend does not have is how you get a confusing node error
    // after the model has already spent a minute loading.
    const missing = [...wanted].filter((type) => !available.has(type));
    if (missing.length > 0) continue;

    // Prefer the workflow that is the closest fit - fewest unused classes - so a graph
    // made of generic nodes lands on the most specific resource for it.
    const unused = [...available].filter((type) => !wanted.has(type)).length;
    candidates.push({ id, resource, score: -unused, missing: missing.length });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score || a.resource.priority - b.resource.priority);
  return candidates[0];
}

/**
 * Turn a graph plus a target resource into the workflow to actually submit.
 *
 * The caller's graph wins where its classes exist in the resource's workflow, because
 * that is what it asked for. What is added on top is only what the resource needs to
 * produce a file the caller can retrieve: the class types a caller rarely wants to think
 * about, and a save node pointed at this gateway's output directory.
 *
 * @param {object} resource - the chosen resource.
 * @param {object} graph - the caller's graph.
 * @returns {object} a submittable graph.
 */
function composeFor(resource, graph) {
  // A caller that submits a complete graph - including its own save node - gets exactly
  // that. Rewriting it would make the gateway unable to run a workflow it did not write,
  // which is the opposite of speaking ComfyUI.
  const hasSave = Object.values(graph).some((node) => (
    typeof node?.class_type === 'string' && node.class_type.startsWith('Save')
  ));
  if (hasSave) return graph;

  // No save node: the caller probably composed just the interesting part. Append the one
  // this resource uses so the output can be found. The class differs per backend - images
  // save with SaveImage, audio with SaveAudioAdvanced - so it is taken from the
  // resource's own workflow rather than guessed.
  const stored = comfy.buildWorkflow(resource.workflow, {});
  const saveEntry = Object.entries(stored).find(([, node]) => (
    typeof node?.class_type === 'string' && node.class_type.startsWith('Save')
  ));
  if (!saveEntry) return graph;

  const [saveId, saveNode] = saveEntry;
  const composed = structuredClone(graph);

  // Find what the stored save node consumes, and point it at whatever in the caller's
  // graph produces the same kind of thing. Matching on the source node's output name is
  // not possible - the caller's ids differ - so the last node with a matching class is
  // the best available signal.
  const sourceKey = Object.keys(saveNode.inputs ?? {})
    .find((key) => Array.isArray(saveNode.inputs[key]));
  if (!sourceKey) return graph;

  const wantedClass = stored[saveNode.inputs[sourceKey][0]]?.class_type;
  const match = Object.entries(composed)
    .reverse()
    .find(([, node]) => node?.class_type === wantedClass);
  if (!match) return graph;

  composed[saveId] = {
    ...structuredClone(saveNode),
    inputs: { ...structuredClone(saveNode.inputs), [sourceKey]: [match[0], 0] },
  };
  return composed;
}

/** Record one execution in ComfyUI's history shape. */
function remember(promptId, entry) {
  executions.set(promptId, { ...entry, at: Date.now() });

  // Opportunistic cleanup: no timer to leak, and a stale entry is never useful.
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, record] of executions) {
    if (record.at < cutoff) executions.delete(id);
  }
}

/**
 * `POST /prompt` - submit a graph and run it.
 *
 * ComfyUI answers immediately with a `prompt_id` and runs the work in the background. The
 * same contract is kept here, because a client that is used to polling `/history` must not
 * have to change: the response arrives before the model has even loaded.
 *
 * @param {object} body - `{prompt, client_id?, extra_data?}`.
 * @returns {Promise<object>} `{prompt_id, number, node_errors}`.
 */
export async function submitPrompt(body) {
  const graph = body?.prompt;
  if (!graph || typeof graph !== 'object') {
    const error = new Error('prompt is required and must be an API-format graph');
    error.status = 400;
    throw error;
  }

  const match = inferResource(graph);
  if (!match) {
    const error = new Error(
      'no configured model can run this graph: no resource\'s workflow contains all of ' +
      `its node classes (${[...new Set(Object.values(graph).map((n) => n?.class_type))].join(', ')})`,
    );
    error.status = 400;
    throw error;
  }

  const promptId = randomUUID();
  const startedAtIso = new Date().toISOString();

  // Record it as running before handing off, so a poll arriving in the first millisecond
  // sees "queued" rather than a 404 that looks like a lost submission.
  remember(promptId, {
    status: { status_str: 'success', completed: false, messages: [] },
    outputs: {},
    resource: match.id,
    prompt: graph,
    startedAt: startedAtIso,
  });

  heartbeat.noteActivity(`POST /prompt -> ${match.id}`);

  // Fire and forget: the HTTP response is sent as soon as this returns, matching ComfyUI.
  // A failure is recorded into the history entry rather than thrown, because the caller
  // is no longer listening - it will poll.
  //
  // Timing is measured from here, not from inside runWorkflow. Everything the caller waits
  // for happens after this point: the scheduler may have to stop another model, free VRAM
  // and start this one, and only then does ComfyUI begin. An earlier version started the
  // clock inside runWorkflow and reported 7s for a call the client measured at 20s, with
  // the missing 13 seconds being exactly the cold start the numbers were supposed to
  // expose. `startedAtIso` above is the same instant, recorded for the history entry.
  const acceptedAt = Date.now();

  void scheduler.run(match.id, async (resource) => {
    const composed = composeFor(resource, graph);
    const url = ports.backendUrl(resource);
    const result = await comfy.runWorkflow(url, composed, body.timeout_sec ?? body.timeoutSec ?? 900);

    // Wall clock from acceptance through to the last byte of work, including the start.
    const totalSec = Number(((Date.now() - acceptedAt) / 1000).toFixed(1));
    // runWorkflow measured only ComfyUI's own execution, which is what "generate" means.
    const generateSec = result.generateSec;
    // What the gateway spent making the model available: scheduler admittance plus startup.
    const loadSec = Number(Math.max(0, totalSec - generateSec).toFixed(1));

    const artifacts = [
      ...result.images.map((filename) => ({ type: 'image', filename })),
      ...result.audio.map((filename) => ({ type: 'audio', filename })),
    ];

    remember(promptId, {
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: {
        // ComfyUI's output shape: one entry per node, with images/audio arrays of
        // {filename, subfolder, type}.
        [match.id]: {
          images: result.images.map((filename) => ({ filename, subfolder: '', type: 'output' })),
          audio: result.audio.map((filename) => ({ filename, subfolder: '', type: 'output' })),
        },
      },
      // Extra fields the gateway adds. ComfyUI clients ignore what they do not know.
      resource: match.id,
      prompt: graph,
      artifacts,
      outputDir: resource.outputDir ?? null,
      // Rolled up here rather than inside runWorkflow, because only this frame knows when the
      // request was accepted - and the wait before that is the cold start a caller wants to
      // see. `elapsedSec` is everything the caller waited; `generateSec` is ComfyUI working;
      // `loadSec` is the difference, i.e. admittance plus model startup.
      elapsedSec: totalSec,
      generateSec,
      loadSec,
      // When the gateway accepted the submission, so a client can compute its own
      // end-to-end figure without trusting the gateway's clock.
      startedAt: startedAtIso,
      completedAt: new Date().toISOString(),
    });

    log.info(`/prompt ${promptId} finished on ${match.id} (${result.images.length} image(s), ` +
      `${result.audio.length} audio)`);
  }).catch((error) => {
    remember(promptId, {
      status: {
        status_str: 'error',
        completed: false,
        messages: [['execution_error', {
          node_type: match.id,
          exception_message: String(error?.message ?? error).slice(0, 500),
        }]],
      },
      outputs: {},
      resource: match.id,
      prompt: graph,
    });
    log.error(`/prompt ${promptId} failed on ${match.id}`,
      String(error?.message ?? error).slice(0, 300));
  });

  return {
    prompt_id: promptId,
    number: 1,
    node_errors: {},
  };
}

/**
 * `GET /history/<id>` and `GET /history`.
 *
 * @param {string} [promptId] - one execution, or all when omitted.
 * @returns {object} ComfyUI's `{promptId: entry}` shape.
 */
export function history(promptId) {
  if (promptId) {
    const entry = executions.get(promptId);
    if (!entry) return {};
    const { at, ...rest } = entry;
    return { [promptId]: rest };
  }

  const all = {};
  for (const [id, entry] of executions) {
    const { at, ...rest } = entry;
    all[id] = rest;
  }
  return all;
}

/**
 * `GET /queue` - what is waiting and what is running.
 *
 * @returns {object} `{queue_running, queue_pending}`.
 */
export function queue() {
  const waiting = scheduler.queueSnapshot();
  const running = [];

  for (const [id, entry] of executions) {
    if (entry.status?.completed === false && entry.status?.status_str !== 'error') {
      running.push([0, id, entry.prompt ?? {}, {}, [entry.resource ?? '']]);
    }
  }

  return {
    queue_running: running,
    queue_pending: waiting.map((ticket, index) => [
      index, ticket.id, {}, {}, [ticket.resource],
    ]),
  };
}

/**
 * `POST /interrupt` - cancel.
 *
 * Honest about its limits: the gateway can refuse to start work and can stop a model, but
 * it cannot abort a graph that ComfyUI is already sampling - that would need ComfyUI's own
 * `/interrupt`, which is reachable per-resource through `/backends/<id>/interrupt`.
 *
 * @returns {{ok: boolean, note: string}} what happened.
 */
export function interrupt() {
  const config = getConfig();
  const stopped = [];

  for (const [id, entry] of executions) {
    if (entry.status?.completed !== false) continue;
    executions.delete(id);
    stopped.push(id);
  }

  return {
    ok: true,
    note: 'cancelled queued work; a graph already sampling inside ComfyUI is not aborted - ' +
      `use POST /backends/<id>/interrupt for that (resources: ${Object.keys(config.resources).join(', ')})`,
    cancelled: stopped,
  };
}

/**
 * `GET /object_info` - the node classes available through this gateway.
 *
 * ComfyUI reports every node its install has. The useful subset here is the nodes that the
 * configured workflows actually use, because those are the ones a caller can submit and
 * expect to work - listing the other thousands would suggest support that is not there.
 *
 * @returns {object} `{className: {...}}`.
 */
export function objectInfo() {
  const config = getConfig();
  const info = {};

  for (const resource of Object.values(config.resources)) {
    if (resource.backend !== 'comfy') continue;

    for (const type of availableClasses(resource)) {
      if (info[type]) continue;
      // The detailed input schema is only known for classes that appear in a stored
      // workflow; a code-built resource contributes its class names, which is what
      // discovery needs.
      let inputs = {};
      if (resource.workflow) {
        try {
          const stored = comfy.buildWorkflow(resource.workflow, {});
          const node = Object.values(stored).find((candidate) => candidate?.class_type === type);
          inputs = node?.inputs ?? {};
        } catch {
          inputs = {};
        }
      }

      info[type] = {
        input: {
          required: Object.fromEntries(
            Object.entries(inputs).map(([key, value]) => [
              key,
              Array.isArray(value)
                ? ['LINK']
                : [typeof value === 'number' ? 'INT' : 'STRING', { default: value }],
            ]),
          ),
        },
        output: [],
        name: type,
        display_name: type,
        description: `available via resource "${resource.id}" (${resource.label})`,
        category: 'lm-gateway',
      };
    }
  }

  return info;
}

/**
 * `GET /models` - what this gateway can run, and which ports it chose.
 *
 * Not a ComfyUI endpoint, but there is no ComfyUI equivalent for "which of the configured
 * models would accept this graph", and a caller debugging a rejection needs it.
 *
 * @returns {object} resources with their allocated ports.
 */
export function models() {
  const config = getConfig();

  return {
    gateway: {
      port: config.gateway.port,
      // The point of the whole exercise: one port for callers.
      endpoints: ['/prompt', '/history', '/queue', '/interrupt', '/object_info', '/models'],
    },
    resources: Object.entries(config.resources).map(([id, resource]) => ({
      id,
      label: resource.label,
      backend: resource.backend,
      workflow: resource.workflow ?? null,
      // The allocated port, which the gateway chose rather than read from a file.
      port: resource.port,
      enabled: resource.enabled,
    })),
  };
}