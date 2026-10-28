/**
 * Print the widget list each node class needs, straight from the live server.
 *
 * Written because guessing widget counts from the schema by eye kept producing the same
 * class of error: ComfyUI reads `widgets_values` positionally, so one value too many or too
 * few puts every later value in the wrong box and the canvas shows nonsense without
 * reporting anything. The rules are mechanical, so this prints them instead of reasoning
 * about them:
 *
 *   a link input contributes no widget
 *   an input whose options carry `control_after_generate` contributes two (the value and
 *   the dropdown the canvas draws beside it)
 *   everything else contributes one
 *   an autogrow block with min 0 contributes none
 */

const HOST = process.env.COMFY_HOST ?? 'http://127.0.0.1:8188';

/** Input names that arrive as links rather than widget values. */
const LINK_INPUTS = new Set([
  'clip', 'model', 'positive', 'negative', 'latent_image', 'samples', 'vae',
  'images', 'image', 'pixels', 'breeze_model', 'reference_audio', 'audio', 'mask',
]);

/**
 * How many widget values a node type stores.
 *
 * @param {object} info - the node's object_info entry.
 * @returns {{count: number, parts: string[]}} the total and how it was reached.
 */
function widgets(info) {
  const required = info?.input?.required ?? {};
  const optional = info?.input?.optional ?? {};
  const parts = [];
  let count = 0;

  for (const [name, spec] of Object.entries({ ...required, ...optional })) {
    if (LINK_INPUTS.has(name)) {
      parts.push(`${name}<link>`);
      continue;
    }

    const options = Array.isArray(spec) && spec.length > 1 && typeof spec[1] === 'object'
      ? spec[1]
      : {};

    // An optional autogrow block with min 0 has no fixed widget value.
    const template = options.template;
    if (template && template.min === 0) {
      parts.push(`${name}<autogrow>`);
      continue;
    }

    if (options.control_after_generate) {
      count += 2;
      parts.push(`${name}+cag`);
    } else {
      count += 1;
      parts.push(name);
    }
  }

  return { count, parts };
}

const types = process.argv.slice(2);
if (types.length === 0) {
  console.error('usage: node probe-widgets.js <NodeType> [<NodeType> ...]');
  process.exit(2);
}

for (const type of types) {
  const response = await fetch(`${HOST}/object_info/${type}`);
  if (!response.ok) {
    console.log(`${type}: server does not have this node`);
    continue;
  }
  const info = (await response.json())?.[type];
  const { count, parts } = widgets(info);
  console.log(`${type}: ${count} widgets`);
  console.log(`  ${parts.join(', ')}`);
}