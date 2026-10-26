/**
 * Command-line access to the running gateway.
 *
 * `status` is for looking, `smoke` is for proving the behaviours this project was
 * specified around. The smoke test deliberately avoids generating anything: the
 * claims worth checking are about *refusal* - that a switched-off resource does not
 * get spawned anyway - and those are verifiable in seconds, whereas a real image
 * takes over two minutes. What it cannot fake is checked against the port itself
 * rather than against the gateway's own opinion, so a gateway that merely believed it
 * had not started something would still fail.
 */

import { createConnection } from 'node:net';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';

/**
 * Is anything listening on this port?
 *
 * Asked of the operating system rather than of the gateway, so the answer does not
 * depend on the gateway's own bookkeeping being right.
 *
 * @param {number} port - TCP port.
 * @param {number} timeoutMs - connect timeout.
 * @returns {Promise<boolean>} true when a connection completes.
 */
function portOpen(port, timeoutMs = 1500) {
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
 * Call the gateway.
 *
 * @param {string} method - HTTP method.
 * @param {string} path - path under BASE.
 * @param {object} [body] - JSON body for POST.
 * @returns {Promise<{status: number, body: any}>}
 */
async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function commandStatus() {
  const { status, body } = await call('GET', '/api/status');
  if (status !== 200) {
    console.error(`gateway answered ${status}: ${JSON.stringify(body)}`);
    return 1;
  }

  console.log(`master        ${body.master ? 'ON ' : 'OFF'}`);
  console.log(`gpu           ${body.gpu.usedMiB} used / ${body.gpu.totalMiB} total, ` +
    `${body.gpu.usableMiB} usable after ${body.gpu.headroomMiB} MiB headroom`);
  console.log();

  const pad = (value, width) => String(value).padEnd(width);
  console.log(`${pad('id', 9)}${pad('enabled', 9)}${pad('state', 11)}${pad('port', 7)}` +
    `${pad('vram', 8)}${pad('prio', 6)}${pad('keepAlive', 11)}${pad('left', 7)}label`);
  console.log('-'.repeat(96));

  for (const resource of body.resources) {
    const left = resource.keepAliveRemainingSec === null ? '-' : `${resource.keepAliveRemainingSec}s`;
    console.log(
      `${pad(resource.id, 9)}${pad(resource.enabled ? 'on' : 'off', 9)}${pad(resource.state, 11)}` +
      `${pad(resource.port, 7)}${pad(resource.vramMiB, 8)}${pad(resource.priority, 6)}` +
      `${pad(resource.keepAliveSec === -1 ? 'stay' : `${resource.keepAliveSec}s`, 11)}${pad(left, 7)}` +
      `${resource.label}${resource.lastError ? `  [lastError: ${resource.lastError.slice(0, 60)}]` : ''}`,
    );
  }

  if (body.queue.length > 0) {
    console.log();
    console.log(`queue (${body.queue.length}):`);
    for (const ticket of body.queue) {
      console.log(`  ${ticket.resource} priority ${ticket.priority}, waiting ${ticket.waitingMs}ms`);
    }
  }

  return 0;
}

/** One assertion, with output that says what was expected and what happened. */
function check(results, name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function commandSmoke() {
  const results = [];

  console.log('smoke test: refusal and release semantics');
  console.log();

  let status;
  try {
    status = await call('GET', '/api/status');
  } catch (error) {
    console.error(`gateway is not reachable at ${BASE}: ${String(error?.message ?? error)}`);
    return 1;
  }
  if (status.status !== 200) {
    console.error(`gateway answered ${status.status}`);
    return 1;
  }

  const imageResource = status.body.resources.find((resource) => resource.id === 'image');
  if (!imageResource) {
    console.error('no "image" resource in config; smoke test needs one');
    return 1;
  }
  const port = imageResource.port;

  // --- baseline: remember the state so the test restores it -------------------
  const masterWas = status.body.master;
  const imageWas = imageResource.enabled;

  try {
    // --- 1. master off refuses, and does not spawn ---------------------------
    console.log('1. master switch off');
    await call('POST', '/api/master', { enabled: false });
    const refused = await call('POST', '/api/image', { prompt: 'smoke test' });

    check(results, 'master off -> 409', refused.status === 409,
      `got ${refused.status}`);
    check(results, 'master off -> reason "master"', refused.body?.reason === 'master',
      `reason=${refused.body?.reason}`);
    check(results, 'master off -> port still closed', !(await portOpen(port)),
      `port ${port}`);

    // --- 2. master on but resource off refuses too ---------------------------
    console.log('2. resource switch off (master on)');
    await call('POST', '/api/master', { enabled: true });
    await call('POST', '/api/resources/image', { enabled: false });

    const refused2 = await call('POST', '/api/image', { prompt: 'smoke test' });
    check(results, 'resource off -> 409', refused2.status === 409, `got ${refused2.status}`);
    check(results, 'resource off -> reason "resource"', refused2.body?.reason === 'resource',
      `reason=${refused2.body?.reason}`);
    check(results, 'resource off -> port still closed', !(await portOpen(port)), `port ${port}`);

    const manual = await call('POST', '/api/resources/image/start');
    check(results, 'resource off -> manual start refused', manual.body?.ok === false,
      `ok=${manual.body?.ok}`);
    check(results, 'resource off -> port STILL closed after manual start',
      !(await portOpen(port)), `port ${port}`);

    // --- 3. state reports disabled ------------------------------------------
    console.log('3. status reflects the switch');
    const afterOff = await call('GET', '/api/status');
    const imageOff = afterOff.body.resources.find((resource) => resource.id === 'image');
    check(results, 'state reads "disabled" when off', imageOff.state === 'disabled',
      `state=${imageOff.state}`);

    // --- 4. keepAlive is adjustable and persisted ----------------------------
    console.log('4. keepAlive adjustable');
    await call('POST', '/api/resources/image', { keepAliveSec: 77 });
    const afterKeep = await call('GET', '/api/status');
    const imageKeep = afterKeep.body.resources.find((resource) => resource.id === 'image');
    check(results, 'keepAliveSec persists as 77', imageKeep.keepAliveSec === 77,
      `got ${imageKeep.keepAliveSec}`);

    const bad = await call('POST', '/api/resources/image', { keepAliveSec: -5 });
    check(results, 'keepAliveSec below -1 rejected as 400', bad.status === 400,
      `got ${bad.status}`);

    // --- 5. config validates on write ----------------------------------------
    console.log('5. config endpoint');
    const config = await call('GET', '/api/config');
    check(results, 'GET /api/config returns resources', Boolean(config.body?.resources),
      Object.keys(config.body?.resources ?? {}).join(','));
  } finally {
    // Restore whatever the operator had before the test ran, so a smoke test never
    // leaves the machine in a state nobody asked for.
    await call('POST', '/api/resources/image', { enabled: imageWas, keepAliveSec: imageResource.keepAliveSec });
    await call('POST', '/api/master', { enabled: masterWas });
  }

  const failed = results.filter((result) => !result.passed);
  console.log();
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('failed:');
    for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
    return 1;
  }
  return 0;
}

const command = process.argv[2] ?? 'status';

/**
 * Exit with a status, without forcing the process down mid-close.
 *
 * `process.exit()` here tripped a libuv assertion on Windows
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, async.c) because it stops
 * the loop while an HTTP socket is still closing - and the assertion itself sets the
 * exit code to 1, so a passing test reported failure to whatever ran it. Setting
 * `exitCode` and letting the loop drain produces the same status cleanly.
 */
function exit(code) {
  process.exitCode = code;
  // undici keeps connections alive for a few seconds, which would otherwise hold the
  // process open after the work is done. This is the backstop; if the loop drains
  // first, the unref'd timer never fires.
  const backstop = setTimeout(() => process.exit(code), 3_000);
  backstop.unref();
}

try {
  const code = command === 'status' ? await commandStatus()
    : command === 'smoke' ? await commandSmoke()
      : (console.error(`unknown command "${command}"; expected status or smoke`), 2);
  exit(code);
} catch (error) {
  console.error(String(error?.stack ?? error));
  exit(1);
}