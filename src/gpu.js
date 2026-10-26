/**
 * Reading the card's memory.
 *
 * Every admission decision in this gateway comes down to one question: is there
 * room right now? On an 8 GB laptop card shared with a desktop compositor, the
 * answer changes minute to minute, so it is measured rather than assumed.
 *
 * The numbers come from nvidia-smi, not from torch or pynvml, because the gateway
 * is a plain Node process and must not depend on a Python environment being
 * importable. Measured on this machine, one call costs ~40 ms, which is why results
 * are cached briefly: a burst of status polls should not spawn a process each.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CACHE_MS = 700;

let cached = null;
let cachedAt = 0;

/**
 * Query total/used/free VRAM in MiB.
 *
 * @returns {Promise<{totalMiB: number, usedMiB: number, freeMiB: number, ok: boolean, error?: string}>}
 */
export async function readGpu({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cached && now - cachedAt < CACHE_MS) return cached;

  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
      { timeout: 10_000, windowsHide: true },
    );

    // First GPU only. This box has one, and a multi-GPU split would need a
    // per-resource device field that the config does not have.
    const first = String(stdout).trim().split('\n')[0];
    const [totalMiB, usedMiB, freeMiB] = first.split(',').map((part) => Number(part.trim()));

    if (!Number.isFinite(totalMiB)) throw new Error(`unparsable nvidia-smi output: ${first}`);

    cached = { totalMiB, usedMiB, freeMiB, ok: true };
  } catch (error) {
    cached = {
      totalMiB: 0,
      usedMiB: 0,
      freeMiB: 0,
      ok: false,
      error: String(error?.message ?? error).slice(0, 200),
    };
  }

  cachedAt = now;
  return cached;
}

/**
 * How much a new model may actually take.
 *
 * `headroomMiB` is subtracted because the desktop and browser compositor share this
 * card: letting a model claim the last megabyte is how the driver ends up silently
 * paging weights to the host, which on this hardware shows up as a device-mismatch
 * crash rather than as a clean out-of-memory error.
 *
 * @param {{totalMiB:number, usedMiB:number, freeMiB:number}} gpu - from readGpu.
 * @param {number} headroomMiB - safety margin from config.
 * @returns {number} MiB a new resource may use.
 */
export function usableMiB(gpu, headroomMiB) {
  return Math.max(0, gpu.freeMiB - headroomMiB);
}