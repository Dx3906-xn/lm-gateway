/**
 * Process entry point.
 *
 * On the way down this frees the card. That matters more than it looks: every service
 * here is spawned as a child of this process, and an abandoned ComfyUI holds ~5.7 GB
 * that nothing will reclaim - the next start then fails for no visible reason, or the
 * desktop starts paging. Measured on this machine, an orphaned service left behind by
 * a killed launcher held 5817 MiB until it was found by hand.
 *
 * It also has to survive being killed without warning. The gateway once vanished during
 * a `/api/speak` call with an empty stderr and no exception logged, which means it was
 * terminated from outside rather than by a JavaScript throw. Nothing inside a process can
 * intercept that, so this file (a) keeps a heartbeat on disk so the *next* start can
 * report the gap, and (b) refuses to start when another gateway already owns the
 * directory, because two of them would fight over the same child services.
 */

import { startServer } from './server.js';
import { loadConfig } from './config.js';
import * as scheduler from './scheduler.js';
import * as heartbeat from './heartbeat.js';
import { log } from './log.js';

let server = null;
let shuttingDown = false;

/**
 * Stop everything and exit.
 *
 * Bounded on purpose. `server.close()` waits for every open connection to finish, and a
 * long-polling request would otherwise hold the process open indefinitely - which is
 * indistinguishable from a hang to whoever asked it to stop.
 *
 * @param {string} reason - why, for the log.
 */
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`shutting down (${reason})`);
  heartbeat.noteActivity(`shutdown: ${reason}`);
  scheduler.disarmAll();

  // Children first: they hold the VRAM, and the point of shutting down is to give it back.
  try {
    await scheduler.stopAll();
  } catch (error) {
    log.warn('stopAll during shutdown failed', String(error?.message ?? error).slice(0, 200));
  }

  if (server) {
    await new Promise((resolve) => {
      const forced = setTimeout(resolve, 3_000);
      if (typeof forced.unref === 'function') forced.unref();
      server.close(() => {
        clearTimeout(forced);
        resolve();
      });
    });
  }

  // Written last, and only here: the next start treats a missing clean marker as an
  // unclean death, so this must not run on any other path.
  heartbeat.markCleanExit(reason);
  heartbeat.releaseLock();
  process.exit(0);
}

async function main() {
  // Fail loudly on a broken config rather than starting and answering every request
  // with a confusing error.
  const config = loadConfig();

  const lock = heartbeat.acquireLock();
  if (!lock.ok) {
    log.error(
      `another gateway is already running (pid ${lock.existingPid}) and owns ` +
      `${config.gateway.host}:${config.gateway.port}. Two gateways would fight over the ` +
      'same child services - stop the other one first.',
    );
    process.exit(1);
  }

  // Report how the previous run ended, before anything else claims the log.
  const previous = heartbeat.inspectPreviousRun();
  if (previous) log.warn(previous);

  log.info(`config loaded from ${Object.keys(config.resources).length} resources`);

  for (const [id, resource] of Object.entries(config.resources)) {
    log.info(`  resource ${id}: port ${resource.port}, ${resource.vramMiB} MiB, priority ${resource.priority}, ` +
      `keepAlive ${resource.keepAliveSec}s, enabled=${resource.enabled}`);
  }

  server = await startServer();
  heartbeat.startHeartbeat();

  // The server cannot import this file without a cycle, so the shutdown path is published
  // for it. `POST /api/shutdown` needs it: Windows delivers no usable SIGTERM to a
  // detached process, so `Stop-Process` is a terminate, and a terminate orphans the child
  // services along with their VRAM.
  globalThis.__lmGatewayShutdown = { requestShutdown: shutdown };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A crash that skips cleanup would strand GBs of VRAM, so these paths stop first.
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', String(error?.stack ?? error).slice(0, 1000));
    heartbeat.noteError(String(error?.message ?? error));
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', String(reason).slice(0, 1000));
    heartbeat.noteError(String(reason));
  });

  // Windows consoles do not deliver SIGINT reliably when the process is detached, so
  // Ctrl-C arriving as a read error is handled as well.
  process.stdin.on('error', () => {});
}

main().catch((error) => {
  log.error('gateway failed to start', String(error?.message ?? error));
  process.exit(1);
});