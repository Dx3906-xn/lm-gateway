/**
 * The memory-retrieval service.
 *
 * A small embedding model behind a hand-written HTTP server. Unlike the other
 * backends it can shut itself down, which is why stopping it is a POST rather than a
 * process kill - the service releases its own VRAM and exits, and that is strictly
 * safer than racing a kill against it.
 */

/**
 * Is the service up?
 *
 * @param {string} base - service base URL.
 * @returns {Promise<object|null>} health payload, or null.
 */
export async function health(base) {
  try {
    const response = await fetch(`${base}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * POST JSON to the embedding service, with a deadline.
 *
 * The timeout is not decoration. A stuck service - or one whose process was killed
 * while a request was in flight, which this gateway has done to it once - leaves the
 * connection open and the caller waiting forever. Without a deadline that becomes a
 * request that never returns and never errors, which is the worst state a caller can
 * be left in, because there is nothing to retry against.
 *
 * @param {string} url - full endpoint.
 * @param {object} payload - JSON body.
 * @param {number} timeoutSec - deadline.
 * @returns {Promise<object>} parsed response.
 */
async function postJson(url, payload, timeoutSec) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      // Body is sent as a UTF-8 string with the charset declared. On this machine a
      // PowerShell caller must go further and pass raw bytes; from Node this is
      // already correct, but the charset header is what makes it explicit.
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`embed server returned ${response.status}: ${detail.slice(0, 300)}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`embed server did not answer within ${timeoutSec}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed a list of texts.
 *
 * @param {string} base - service base URL.
 * @param {string[]} texts - inputs.
 * @param {number} timeoutSec - deadline.
 * @returns {Promise<{vectors: number[][], dim: number}>}
 */
export async function embed(base, texts, timeoutSec = 120) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('embed requires a non-empty "texts" array');
  return postJson(`${base}/embed`, { texts }, timeoutSec);
}

/**
 * Rank candidate texts against a query.
 *
 * @param {string} base - service base URL.
 * @param {string} query - the query.
 * @param {string[]} texts - candidates.
 * @param {number} timeoutSec - deadline.
 * @returns {Promise<{scores: number[]}>}
 */
export async function similarity(base, query, texts, timeoutSec = 120) {
  return postJson(`${base}/similarity`, { query, texts }, timeoutSec);
}

/**
 * Ask the service to exit.
 *
 * @param {string} base - service base URL.
 * @returns {Promise<boolean>} whether the request was accepted.
 */
export async function shutdown(base) {
  try {
    const response = await fetch(`${base}/shutdown`, { method: 'POST' });
    return response.ok;
  } catch {
    // Already gone is a success for a shutdown request.
    return true;
  }
}