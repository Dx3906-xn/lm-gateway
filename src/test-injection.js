/**
 * Verify prompt injection picks the right field for each workflow.
 *
 * This exists because of a defect that shipped in the config before it was caught:
 * Qwen-Image's text node takes `prompt`, Anima's takes `text`. ComfyUI ignores unknown
 * inputs, so injecting the wrong name produces a successful run whose image ignores the
 * prompt entirely - no error, no warning, just the wrong picture.
 *
 * The two assertions that matter are therefore the negative one (a wrong field must be
 * refused) and that each resource's declared target really exists in its own workflow.
 *
 * Anima used to be a workflow of the `image` resource, so this test compared two injection
 * points inside one resource. It is a resource of its own now (it needed its own controls),
 * which is a better arrangement: each resource declares one target, and there is no
 * per-workflow switch to get wrong.
 *
 * Pure logic: no ComfyUI, no GPU, no network.
 */

import { getConfig } from './config.js';
import { buildWorkflow, resolveInjection, nodeFields } from './backends/comfy.js';
import { createReporter, exitWith } from './test-util.js';

const { check, finish } = createReporter();

function throws(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
}

console.log('prompt injection per workflow');
console.log();

const config = getConfig();
const image = config.resources.image;
const anima = config.resources.anima;

// --- 1. each resource resolves its own injection point ----------------------
console.log('1. injection point resolution');
check('image resource exists', Boolean(image), Object.keys(config.resources).join(','));
check('anima resource exists', Boolean(anima), 'anima is its own resource');

const qwen = resolveInjection(image, 'qwen21-image-api.json', 'prompt');
const animaTarget = resolveInjection(anima, 'anima-image-api.json', 'prompt');

check('qwen21 -> field "prompt"', qwen?.field === 'prompt', JSON.stringify(qwen));
check('anima  -> field "text"', animaTarget?.field === 'text', JSON.stringify(animaTarget));
check('the two differ', qwen?.field !== animaTarget?.field,
  `${qwen?.field} vs ${animaTarget?.field}`);

// --- 2. the declared fields actually exist in the workflows ------------------
console.log('2. declared fields exist in the target node');
check('qwen21 node 4 has the declared field',
  nodeFields('qwen21-image-api.json', qwen.node).includes(qwen.field),
  `node ${qwen.node} has: ${nodeFields('qwen21-image-api.json', qwen.node).join(', ')}`);
check('anima node 4 has the declared field',
  nodeFields('anima-image-api.json', animaTarget.node).includes(animaTarget.field),
  `node ${animaTarget.node} has: ${nodeFields('anima-image-api.json', animaTarget.node).join(', ')}`);

// --- 3. injecting the right field works and lands the value ----------------
console.log('3. injection applies the value');
const qwenGraph = buildWorkflow('qwen21-image-api.json', {
  injection: { [qwen.node]: { [qwen.field]: '中文提示词测试' } },
});
check('qwen21 prompt reached the node', qwenGraph[qwen.node].inputs.prompt === '中文提示词测试',
  `got ${JSON.stringify(qwenGraph[qwen.node].inputs.prompt)}`);

const animaGraph = buildWorkflow('anima-image-api.json', {
  injection: { [animaTarget.node]: { [animaTarget.field]: 'masterpiece, test' } },
});
check('anima text reached the node', animaGraph[animaTarget.node].inputs.text === 'masterpiece, test',
  `got ${JSON.stringify(animaGraph[animaTarget.node].inputs.text)}`);

// --- 4. the failure this was written to catch -------------------------------
console.log('4. the wrong field is refused, not silently accepted');
const wrong = throws(() => buildWorkflow('anima-image-api.json', {
  injection: { '4': { prompt: 'this would be ignored by ComfyUI' } },
}));
check('writing "prompt" into anima is refused', wrong !== null,
  wrong ? wrong.slice(0, 80) : 'no error raised - this is the silent-failure bug');
check('refusal names the correct alternatives', Boolean(wrong && wrong.includes('text')),
  wrong ? 'mentions text' : 'n/a');

const wrongNode = throws(() => buildWorkflow('qwen21-image-api.json', {
  injection: { '99': { prompt: 'no such node' } },
}));
check('injection into a missing node is refused', wrongNode !== null,
  wrongNode ? wrongNode.slice(0, 60) : 'no error');

// --- 5. caller overrides still work, and are not silently swallowed ---------
console.log('5. caller overrides');
const overridden = buildWorkflow('qwen21-image-api.json', { override: { '5': { seed: 4242 } } });
check('override changes a node field', overridden['5'].inputs.seed === 4242,
  `got ${overridden['5'].inputs.seed}`);
const badOverride = throws(() => buildWorkflow('qwen21-image-api.json', { override: { '99': { seed: 1 } } }));
check('override into a missing node is refused', badOverride !== null,
  badOverride ? badOverride.slice(0, 60) : 'no error');

// --- 6. the stored workflow is not mutated ----------------------------------
console.log('6. the stored file is left alone');
buildWorkflow('qwen21-image-api.json', { injection: { '4': { prompt: 'X' } } });
const fresh = buildWorkflow('qwen21-image-api.json', {});
check('a second load does not carry the previous injection',
  fresh['4'].inputs.prompt !== 'X',
  `stored prompt is ${JSON.stringify(fresh['4'].inputs.prompt).slice(0, 40)}`);

exitWith(finish());