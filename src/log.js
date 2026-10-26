/**
 * Logging, deliberately tiny and dependency-free.
 *
 * The gateway runs as a background service on a machine whose console encoding is
 * GBK; anything it prints is redirected to a file that gets read back with a UTF-8
 * editor. So every line is written as UTF-8 and the level is a plain prefix rather
 * than a dependency - this process must start even if npm install never ran.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVELS[process.env.LM_GATEWAY_LOG_LEVEL ?? 'info'] ?? LEVELS.info;

/** Ring buffer of recent lines, so the WebUI can show what just happened. */
const recent = [];
const RECENT_LIMIT = 200;

function emit(level, message, extra) {
  if (LEVELS[level] < threshold) return;

  const stamp = new Date().toISOString();
  let line = `${stamp} [${level}] ${message}`;
  if (extra !== undefined) {
    line += ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  }

  recent.push({ at: stamp, level, message: String(message) });
  if (recent.length > RECENT_LIMIT) recent.shift();

  // stderr for warn/error so a supervisor sees failures even if stdout is filtered.
  const sink = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  sink.write(`${line}\n`);
}

export const log = {
  debug: (message, extra) => emit('debug', message, extra),
  info: (message, extra) => emit('info', message, extra),
  warn: (message, extra) => emit('warn', message, extra),
  error: (message, extra) => emit('error', message, extra),
  recent: () => recent.slice(),
};