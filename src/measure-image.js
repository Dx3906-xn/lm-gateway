/**
 * Measure what an image run actually costs, through the gateway.
 *
 * The configured `vramMiB` for the image resource decides every admission, so it has
 * to be a real number rather than a guess. This drives one run through the public API
 * and samples VRAM throughout, so the figure that ends up in config is the one this
 * machine produced - including the desktop's share, which varies with whatever else is
 * open.
 *
 * Reports the peak and the headroom it leaves, which is what tells you whether the
 * `headroomMiB` safety margin is sized right.
 *
 * Read-only apart from the single image request it is asked to make.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';

/**
 * Current VRAM in MiB.
 *
 * @returns {Promise<{used: number, total: number}|null>}
 */
async function sample() {
  try {
    const { stdout } = await run(
      'nvidia-smi',
      ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 10_000, windowsHide: true },
    );
    const [used, total] = String(stdout).trim().split(',').map((part) => Number(part.trim()));
    return { used, total };
  } catch {
    return null;
  }
}

const body = {
  prompt: process.argv[2] ?? '生成一张漫画风格的慵懒少女',
  override: { 5: { seed: 31337 } },
  timeoutSec: 900,
};

console.log('=== before ===');
const before = await sample();
console.log(`vram used ${before?.used} / ${before?.total} MiB`);

const statusBefore = await (await fetch(`${BASE}/api/status`)).json();
const imageBefore = statusBefore.resources.find((resource) => resource.id === 'image');
console.log(`image state=${imageBefore.state} enabled=${imageBefore.enabled} ` +
  `configured vramMiB=${imageBefore.vramMiB}`);
console.log(`usable (per gateway) ${statusBefore.gpu.usableMiB} MiB, ` +
  `headroom ${statusBefore.gpu.headroomMiB} MiB`);
console.log();

const peak = { used: before?.used ?? 0 };

const stop = { done: false };
const sampler = (async () => {
  while (!stop.done) {
    const reading = await sample();
    if (reading && reading.used > peak.used) peak.used = reading.used;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
})();

console.log('=== calling POST /api/image (this starts ComfyUI if it is down) ===');
const started = Date.now();
const response = await fetch(`${BASE}/api/image`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});
const payload = await response.json();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

stop.done = true;
await sampler;

console.log();
console.log(`=== result (${elapsed}s) ===`);
console.log(`http ${response.status}`);
console.log(JSON.stringify(payload, null, 2));
console.log();
console.log(`=== vram ===`);
console.log(`peak used  ${peak.used} MiB of ${before?.total}`);
console.log(`baseline   ${before?.used} MiB`);
console.log(`delta      ${peak.used - (before?.used ?? 0)} MiB`);

const after = await (await fetch(`${BASE}/api/status`)).json();
const imageAfter = after.resources.find((resource) => resource.id === 'image');
console.log(`image state after: ${imageAfter.state}, keepAlive left: ` +
  `${imageAfter.keepAliveRemainingSec}s`);
if (imageAfter.lastError) console.log(`lastError: ${imageAfter.lastError}`);