/**
 * Talking to GPT-SoVITS.
 *
 * The service's `/tts` endpoint is a GET with query parameters and returns raw audio,
 * which is why this module deals in a URL rather than a JSON body. Two consequences
 * worth knowing:
 *
 *   - The text must be percent-encoded. Chinese passed raw into a URL is not merely
 *     inelegant, it is what makes the service receive the wrong characters.
 *   - The reference audio path and its exact transcript are part of every request.
 *     GPT-SoVITS clones from them per call, so they travel with the request rather
 *     than living in gateway config: the persona's voice is a caller concern.
 */

/**
 * Build the /tts query for a request.
 *
 * @param {object} options - the request.
 * @returns {string} a fully encoded URL.
 */
function buildUrl(base, options) {
  const query = new URLSearchParams({
    text: options.text,
    text_lang: options.textLang ?? options.text_lang ?? 'zh',
    ref_audio_path: options.refAudioPath ?? options.ref_audio_path,
    prompt_text: options.promptText ?? options.prompt_text ?? '',
    prompt_lang: options.promptLang ?? options.prompt_lang ?? 'zh',
    text_split_method: options.textSplitMethod ?? options.text_split_method ?? 'cut5',
    media_type: options.mediaType ?? options.media_type ?? 'wav',
    streaming_mode: 'false',
    speed_factor: String(options.speedFactor ?? options.speed_factor ?? 1.0),
    repetition_penalty: String(options.repetitionPenalty ?? options.repetition_penalty ?? 1.35),
  });

  return `${base}/tts?${query.toString()}`;
}

/**
 * Synthesize speech.
 *
 * @param {string} base - service base URL.
 * @param {object} options - text plus optional voice parameters.
 * @param {number} timeoutSec - budget; the first call loads the model and is slow.
 * @returns {Promise<{bytes: Buffer, contentType: string}>}
 */
export async function speak(base, options, timeoutSec = 300) {
  if (!options?.text) throw new Error('speak requires "text"');
  if (!(options.refAudioPath ?? options.ref_audio_path)) {
    throw new Error('speak requires "refAudioPath": GPT-SoVITS clones from a reference clip per call');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const response = await fetch(buildUrl(base, options), { signal: controller.signal });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`GPT-SoVITS returned ${response.status}: ${detail.slice(0, 300)}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error('GPT-SoVITS returned an empty body');

    return { bytes, contentType: response.headers.get('content-type') ?? 'audio/wav' };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`GPT-SoVITS timed out after ${timeoutSec}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export { buildUrl };