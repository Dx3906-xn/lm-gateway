/**
 * Verify prompt injection picks the right field for each workflow.
 *
 * This exists because of a defect that shipped in the config before it was caught:
 * Qwen-Image's text node takes `prompt`, Anima's takes `text`. ComfyUI ignores unknown
 * inputs, so injecting the wrong name produces a successful run whose image ignores the
 * prompt entirely - no error, no warning, just the wrong picture. The two assertions
 * that matter here are therefore the negative one (wrong field must be refused) and the
 * per-workflow resolution (each workflow must get its own field).
 *
 * Pure logic: no ComfyUI, no GPU, no network.
 */

import { getConfig } from './config.js';
import { buildWorkflow, resolveInjection, nodeFields } from './backends/comfy.js';

const results = [];

/**
 * Record and print one assertion.
 *
 * `results` is closed over rather than passed in, so the signature cannot drift out of
 * step with the call sites. An earlier version declared `(name, passed, detail)` while
 * every call passed four arguments, which shifted a string into the `passed` slot and
 * made all thirteen assertions report PASS regardless of what they tested.
 */
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

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

// --- 1. the config resolves a different field per workflow -------------------
console.log('1. injection point resolution');
const qwen = resolveInjection(image, 'qwen21-image.json', 'prompt');
const anima = resolveInjection(image, 'anima-image.json', 'prompt');

check( 'qwen21 -> field "prompt"', qwen?.field === 'prompt',
  JSON.stringify(qwen));
check( 'anima  -> field "text"', anima?.field === 'text',
  JSON.stringify(anima));
check( 'the two differ', qwen?.field !== anima?.field,
  `${qwen?.field} vs ${anima?.field}`);

// --- 2. the declared fields actually exist in the workflows ------------------
console.log('2. declared fields exist in the target node');
check( 'qwen21 node 4 has the declared field',
  nodeFields('qwen21-image.json', qwen.node).includes(qwen.field),
  `node ${qwen.node} has: ${nodeFields('qwen21-image.json', qwen.node).join(', ')}`);
check( 'anima node 4 has the declared field',
  nodeFields('anima-image.json', anima.node).includes(anima.field),
  `node ${anima.node} has: ${nodeFields('anima-image.json', anima.node).join(', ')}`);

// --- 3. injecting the right field works and lands the value ----------------
console.log('3. injection applies the value');
const qwenGraph = buildWorkflow('qwen21-image.json', {
  injection: { [qwen.node]: { [qwen.field]: '中文提示词测试' } },
});
check( 'qwen21 prompt reached the node',
  qwenGraph[qwen.node].inputs.prompt === '中文提示词测试',
  `got ${JSON.stringify(qwenGraph[qwen.node].inputs.prompt)}`);

const animaGraph = buildWorkflow('anima-image.json', {
  injection: { [anima.node]: { [anima.field]: 'masterpiece, test' } },
});
check( 'anima text reached the node',
  animaGraph[anima.node].inputs.text === 'masterpiece, test',
  `got ${JSON.stringify(animaGraph[anima.node].inputs.text)}`);

// --- 4. the failure this was written to catch -------------------------------
console.log('4. the wrong field is refused, not silently accepted');
const wrong = throws(() => buildWorkflow('anima-image.json', {
  injection: { '4': { prompt: 'this would be ignored by ComfyUI' } },
}));
check( 'writing "prompt" into anima is refused', wrong !== null,
  wrong ? wrong.slice(0, 80) : 'no error raised - this is the silent-failure bug');
check( 'refusal names the correct alternatives',
  Boolean(wrong && wrong.includes('text')), wrong ? 'mentions text' : 'n/a');

const wrongNode = throws(() => buildWorkflow('qwen21-image.json', {
  injection: { '99': { prompt: 'no such node' } },
}));
check( 'injection into a missing node is refused', wrongNode !== null,
  wrongNode ? wrongNode.slice(0, 60) : 'no error');

// --- 5. caller overrides still work, and are not silently swallowed ---------
console.log('5. caller overrides');
const overridden = buildWorkflow('qwen21-image.json', { override: { '5': { seed: 4242 } } });
check( 'override changes a node field',
  overridden['5'].inputs.seed === 4242, `got ${overridden['5'].inputs.seed}`);
const badOverride = throws(() => buildWorkflow('qwen21-image.json', { override: { '99': { seed: 1 } } }));
check( 'override into a missing node is refused', badOverride !== null,
  badOverride ? badOverride.slice(0, 60) : 'no error');

// --- 6. the stored workflow is not mutated ----------------------------------
console.log('6. the stored file is left alone');
const again = buildWorkflow('qwen21-image.json', { injection: { '4': { prompt: 'X' } } });
const fresh = buildWorkflow('qwen21-image.json', {});
check( 'a second load does not carry the previous injection',
  fresh['4'].inputs.prompt !== 'X',
  `stored prompt is ${JSON.stringify(fresh['4'].inputs.prompt).slice(0, 40)}`);

const failed = results.filter((result) => !result.passed);
console.log();
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  process.exit(1);
}