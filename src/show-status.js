/**
 * Print the gateway's live status in a compact form.
 *
 * Used during development to check the group-ownership logic without opening the
 * WebUI: with two resources sharing port 8188, the interesting question is which one
 * the gateway believes is loaded.
 */

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';

const response = await fetch(`${BASE}/api/status`);
if (!response.ok) {
  console.error(`gateway answered ${response.status}`);
  process.exit(1);
}
const status = await response.json();

console.log(`master      ${status.master}`);
console.log(`gpu         ${status.gpu.usedMiB} used / ${status.gpu.totalMiB} total, ` +
  `${status.gpu.usableMiB} usable, ok=${status.gpu.ok}`);
console.log(`groups      ${JSON.stringify(status.groups)}`);
console.log(`queue       ${status.queue.length}`);
console.log();
console.log('id        enabled  state       running  groupActive  blockedByGroup  keepAlive  left');
console.log('-'.repeat(88));

for (const resource of status.resources) {
  const left = resource.keepAliveRemainingSec === null ? '-' : `${resource.keepAliveRemainingSec}s`;
  const keep = resource.keepAliveSec === -1 ? 'stay' : `${resource.keepAliveSec}s`;
  console.log(
    `${resource.id.padEnd(9)} ${String(resource.enabled).padEnd(7)}  ` +
    `${resource.state.padEnd(11)} ${String(resource.running).padEnd(7)}  ` +
    `${String(resource.groupActive ?? '-').padEnd(11)}  ${String(resource.blockedByGroup ?? '-').padEnd(14)}  ` +
    `${keep.padEnd(9)}  ${left}`,
  );
}

const problems = status.resources.filter((resource) => resource.lastError);
if (problems.length > 0) {
  console.log();
  console.log('last errors:');
  for (const resource of problems) {
    console.log(`  ${resource.id}: ${resource.lastError.slice(0, 120)}`);
  }
}