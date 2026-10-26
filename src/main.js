/**
 * Process entry point.
 *
 * On the way down this frees the card. That matters more than it looks: every service
 * here is spawned as a child of this process, and an abandoned ComfyUI holds ~5.7 GB
 * that nothing will reclaim - the next start then fails for no visible reason, or the
 * desktop starts paging. Measured on this machine, an orphaned service left behind by
 * a killed launcher held 5817 MiB until it was found by hand.
 */

import { startServer } from './server.js';
import { loadConfig } from './config.js';
import * as scheduler from './scheduler.js';
import { log } from './log.js';

let server = null;
let shuttingDown = false;

/**
 * Stop everything and exit.
 *
 * @param {string} reason - why, for the log.
 */
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`shutting down (${reason})`);
  scheduler.disarmAll();

  try {
    await scheduler.stopAll();
  } catch (error) {
    log.warn('stopAll during shutdown failed', String(error?.message ?? error).slice(0, 200));
  }

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  process.exit(0);
}

async function main() {
  // Fail loudly on a broken config rather than starting and answering every request
  // with a confusing error.
  const config = loadConfig();
  log.info(`config loaded from ${config.resources ? Object.keys(config.resources).length : 0} resources`);

  for (const [id, resource] of Object.entries(config.resources)) {
    log.info(`  resource ${id}: port ${resource.port}, ${resource.vramMiB} MiB, priority ${resource.priority}, ` +
      `keepAlive ${resource.keepAliveSec}s, enabled=${resource.enabled}`);
  }

  server = await startServer();

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A crash that skips cleanup would strand GBs of VRAM, so these paths stop first.
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', String(error?.stack ?? error).slice(0, 1000));
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', String(reason).slice(0, 1000));
  });

  // Windows consoles do not deliver SIGINT reliably when the process is detached, so
  // Ctrl-C arriving as a read error is handled as well.
  process.stdin.on('error', () => {});
}

main().catch((error) => {
  log.error('gateway failed to start', String(error?.message ?? error));
  process.exit(1);
});