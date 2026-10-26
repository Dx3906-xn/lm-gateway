/**
 * Shared assertion helper for the gateway's test scripts.
 *
 * This exists because the same defect was written three separate times. Each test
 * declared `check(name, passed, detail)` while every call site passed four arguments,
 * so a string landed in the `passed` slot, tested truthy, and made *every* assertion
 * report PASS regardless of what it checked. Three "15/15 passed" and "13/13 passed"
 * results were consequently worthless.
 *
 * A test that cannot fail is worse than no test, because it actively buys confidence
 * it has not earned. Keeping the signature in exactly one place is the fix: there is
 * no second copy of it to drift out of step.
 *
 * Usage:
 *   import { createReporter } from './test-util.js';
 *   const { check, finish } = createReporter('some test');
 *   check('the thing works', condition, `detail ${value}`);
 *   process.exit(finish());
 */

/**
 * Create a reporter bound to one test run.
 *
 * @param {string} [title] - printed first.
 * @returns {{check: Function, section: Function, finish: Function, results: object[]}}
 */
export function createReporter(title) {
  const results = [];

  if (title) {
    console.log(title);
    console.log();
  }

  /**
   * Record and print one assertion.
   *
   * @param {string} name - what is being asserted, phrased so a failure reads as a
   *   sentence ("master off -> 409").
   * @param {boolean} passed - the result.
   * @param {string} [detail] - observed value, printed either way.
   */
  function check(name, passed, detail) {
    const ok = passed === true;
    results.push({ name, passed: ok, detail });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  }

  /** Print a section heading. */
  function section(label) {
    console.log(label);
  }

  /**
   * Print the summary.
   *
   * @returns {number} 0 when everything passed, 1 otherwise - ready for process.exit.
   */
  function finish() {
    const failed = results.filter((result) => !result.passed);
    console.log();
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
      return 1;
    }
    return 0;
  }

  return { check, section, finish, results };
}

/**
 * Call the gateway and parse the response.
 *
 * @param {string} base - gateway base URL.
 * @param {string} method - HTTP method.
 * @param {string} path - path under base.
 * @param {object} [body] - JSON body for POST.
 * @param {number} [timeoutSec] - client-side deadline.
 * @returns {Promise<{status: number, body: any}>}
 */
export async function callGateway(base, method, path, body, timeoutSec = 60) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is anything listening on this port?
 *
 * Asked of the operating system rather than of the gateway, so the answer does not
 * depend on the gateway's own bookkeeping being right.
 *
 * @param {number} port - TCP port.
 * @param {number} [timeoutMs] - connect timeout.
 * @returns {Promise<boolean>} true when a connection completes.
 */
export async function portOpen(port, timeoutMs = 2000) {
  const { createConnection } = await import('node:net');
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/**
 * Exit with a status without forcing the process down mid-close.
 *
 * `process.exit()` tripped a libuv assertion on Windows
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, async.c) when an HTTP
 * socket was still closing, and the assertion sets the exit code to 1 - so a test that
 * printed "16/16 passed" reported failure to whatever ran it. Setting `exitCode` and
 * letting the loop drain fixes both halves of that.
 *
 * @param {number} code - process exit status.
 */
export function exitWith(code) {
  process.exitCode = code;
  // undici holds connections open for a few seconds after the last request, which would
  // otherwise keep the process alive past its work. Backstop only: an unref'd timer
  // does not itself hold the loop open, so a clean drain exits before it fires.
  const backstop = setTimeout(() => process.exit(code), 3_000);
  backstop.unref();
}