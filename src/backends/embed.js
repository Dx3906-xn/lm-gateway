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
 * Embed a list of texts.
 *
 * @param {string} base - service base URL.
 * @param {string[]} texts - inputs.
 * @returns {Promise<{vectors: number[][], dim: number}>}
 */
export async function embed(base, texts) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('embed requires a non-empty "texts" array');

  const response = await fetch(`${base}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    // Body is sent as a UTF-8 string with the charset declared. On this machine a
    // PowerShell caller must go further and pass raw bytes; from Node this is
    // already correct, but the charset header is what makes it explicit.
    body: JSON.stringify({ texts }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`embed server returned ${response.status}: ${detail.slice(0, 300)}`);
  }

  return await response.json();
}

/**
 * Rank candidate texts against a query.
 *
 * @param {string} base - service base URL.
 * @param {string} query - the query.
 * @param {string[]} texts - candidates.
 * @returns {Promise<{scores: number[]}>}
 */
export async function similarity(base, query, texts) {
  const response = await fetch(`${base}/similarity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ query, texts }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`embed server returned ${response.status}: ${detail.slice(0, 300)}`);
  }

  return await response.json();
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