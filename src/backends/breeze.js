/**
 * Building Breeze TTS 2 graphs for ComfyUI.
 *
 * Breeze runs through the ComfyUI node pack rather than a service of its own, so
 * "using" it means constructing a graph. Three modes, matching the model's three
 * capabilities:
 *
 *   design     a voice from a written description, no recording needed
 *   clone      a speaker cloned from reference audio plus its exact transcript
 *   direction  a clone, steered by an instruction (tone, pace, emotion)
 *
 * One setting is pinned rather than exposed: decode_mode is always "eager".
 * Measured on this machine, the "cuda_graphs" fast path succeeds on the first call
 * and then fails on the second with a CPU/CUDA tensor mismatch, escalating to an
 * access violation that takes the whole ComfyUI process down with it. It is not a
 * reasonable default, and not a knob a caller should be able to turn.
 *
 * Two more values are pinned for measured reasons:
 *   attention "sdpa"  - flash_attn is not installable here, and "auto" would try it
 *   cfg_scale         1.0 for clone (reproduce the reference as-is), 4.0 otherwise
 *                     (instruction-following only bites at a higher scale)
 */

const MODEL_LABEL = 'int8 hybrid (recommended)';

const MODES = ['design', 'clone', 'direction'];

/** Generation controls shared by all three nodes. */
function generationControls(options) {
  return {
    max_new_tokens: options.maxNewTokens ?? options.max_new_tokens ?? 1500,
    temperature: options.temperature ?? 0.9,
    top_k: options.topK ?? options.top_k ?? 50,
    top_p: options.topP ?? options.top_p ?? 1.0,
    repetition_penalty: options.repetitionPenalty ?? options.repetition_penalty ?? 1.1,
    depth_temperature: options.depthTemperature ?? options.depth_temperature ?? 0.9,
    depth_top_k: options.depthTopK ?? options.depth_top_k ?? 50,
    depth_top_p: options.depthTopP ?? options.depth_top_p ?? 1.0,
    seed: options.seed ?? 42,
  };
}

/**
 * Build the API-format graph for one request.
 *
 * @param {object} options - the request.
 * @returns {object} a graph ready for `POST /prompt`.
 */
export function buildGraph(options) {
  const mode = options.mode ?? 'design';
  if (!MODES.includes(mode)) {
    throw new Error(`unknown Breeze mode "${mode}"; expected one of ${MODES.join(', ')}`);
  }
  if (!options.text) throw new Error('Breeze requires "text"');

  if (mode === 'design' && !options.instruction) {
    throw new Error('design mode requires "instruction": that description is what creates the voice');
  }
  if (mode !== 'design') {
    if (!options.reference) {
      throw new Error(`${mode} mode requires "reference": a filename in ComfyUI's input directory`);
    }
    if (!options.referenceText && !options.reference_text) {
      // The transcript is not decoration - the model conditions on it, and a wrong
      // one audibly degrades the clone.
      throw new Error(`${mode} mode requires "referenceText": the exact transcript of the reference clip`);
    }
  }

  const generation = generationControls(options);
  const cfgScale = options.cfgScale ?? options.cfg_scale ?? (mode === 'clone' ? 1.0 : 4.0);
  const prefix = options.prefix ?? `breeze-${mode}`;

  const graph = {
    1: {
      class_type: 'BreezeTTS2LoadModel',
      inputs: {
        model: options.model ?? MODEL_LABEL,
        dtype: 'auto',
        device: 'auto',
        attention: 'sdpa',
        decode_mode: 'eager',
        download_if_missing: false,
      },
    },
  };

  let audioSource;
  if (mode === 'design') {
    graph[2] = {
      class_type: 'BreezeTTS2VoiceDesign',
      inputs: {
        breeze_model: ['1', 0],
        text: options.text,
        instruction: options.instruction,
        cfg_scale: cfgScale,
        ...generation,
      },
    };
    audioSource = ['2', 0];
  } else {
    graph[2] = { class_type: 'LoadAudio', inputs: { audio: options.reference } };

    if (mode === 'clone') {
      graph[3] = {
        class_type: 'BreezeTTS2VoiceClone',
        inputs: {
          breeze_model: ['1', 0],
          text: options.text,
          reference_audio: ['2', 0],
          reference_text: options.referenceText ?? options.reference_text,
          cfg_scale: cfgScale,
          ...generation,
        },
      };
    } else {
      graph[3] = {
        class_type: 'BreezeTTS2VoiceDirection',
        inputs: {
          breeze_model: ['1', 0],
          text: options.text,
          reference_audio: ['2', 0],
          reference_text: options.referenceText ?? options.reference_text,
          instruction: options.instruction,
          cfg_scale: cfgScale,
          stitch_reference: options.stitchReference ?? 'none',
          ...generation,
        },
      };
    }
    audioSource = ['3', 0];
  }

  graph[9] = {
    class_type: 'SaveAudioAdvanced',
    inputs: {
      audio: audioSource,
      filename_prefix: prefix,
      format: options.format ?? 'flac',
    },
  };

  return graph;
}

export { MODES, MODEL_LABEL };