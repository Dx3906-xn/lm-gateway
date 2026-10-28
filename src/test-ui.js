/**
 * UI contract test for the control panel, driven through the browser's own devtools protocol.
 *
 * Why this exists: the panel is the part of the gateway a person judges at a glance, and it
 * had already drifted from the API twice - capabilities, routing and backendBusy were all
 * returned by /api/status while nothing on the page showed them. Eyeballing a screenshot
 * cannot catch that reliably, and a screenshot cannot assert "the stop button is marked risky
 * while a graph is executing".
 *
 * So this launches headless Edge, loads the real page against the real gateway, and asks the
 * live DOM questions. A failure here means the page is wrong, not that a mock changed.
 *
 * Static checks always run. The dynamic ones (busy state) only run when --dynamic is passed,
 * because producing that state takes a real model run of about a minute.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const GATEWAY = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9333);
const DYNAMIC = process.argv.includes('--dynamic');
const SHOT = process.env.SHOT_PATH ?? null;

/* ------------------------------------------------------------------ *
 * Minimal CDP client
 * ------------------------------------------------------------------ */

/**
 * One connection to a page target, with request/response correlation.
 *
 * Deliberately small: this needs evaluate, screenshot, navigate and console capture, and a
 * full protocol library would be another dependency for four methods.
 */
class Page {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
    this.dialogs = [];
    this.dialogWaiters = [];

    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }

      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }

      // A native confirm() blocks the page, so a test that ignores it hangs. Recording the
      // dialog is also the point: "the stop button asks before discarding work" is only
      // really verified by seeing the dialog.
      if (message.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(message.params);
        const waiters = this.dialogWaiters;
        this.dialogWaiters = [];
        for (const resolve of waiters) resolve(message.params);
        return;
      }

      // Console errors are collected rather than ignored: a page that renders while throwing
      // is still broken, and the visible symptom is usually "something is missing".
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(
          message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '),
        );
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.pageErrors.push(details.exception?.description ?? details.text ?? 'unknown');
      }
    });
  }

  /**
   * Resolve with the next dialog that opens.
   *
   * @param {number} timeoutMs - how long to wait.
   * @returns {Promise<object|null>} the dialog params, or null on timeout.
   */
  waitForDialog(timeoutMs = 5_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.dialogWaiters.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  /** Accept or dismiss the dialog that is currently open. */
  async answerDialog(accept) {
    await this.send('Page.handleJavaScriptDialog', { accept });
  }

  /**
   * Issue a protocol command.
   *
   * @param {string} method - e.g. "Runtime.evaluate".
   * @param {object} [params] - method parameters.
   * @returns {Promise<any>} the result payload.
   */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * @param {string} expression - JavaScript to run.
   * @returns {Promise<any>} the computed value, or throws with the page's error text.
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text ?? 'evaluation failed');
    }
    return result.result.value;
  }
}

/** Wait until the devtools endpoint answers. */
async function waitForDebugger(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  throw new Error(`browser devtools did not open on port ${DEBUG_PORT}`);
}

/** Open a blank page target and connect to it. */
async function openPage() {
  // Newer builds require PUT for target creation; older ones accept GET.
  let target = null;
  for (const method of ['PUT', 'GET']) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method });
      if (response.ok) { target = await response.json(); break; }
    } catch {
      // Try the next verb.
    }
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('could not create a page target');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
  });

  const page = new Page(socket);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return { page, target, socket };
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed: !!passed, detail: detail ?? '' });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? `  (${detail})` : ''}`);
}
function section(title) { console.log(`\n${title}`); }
function finish() {
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('failed:');
    for (const item of failed) console.log(`  - ${item.name}${item.detail ? `: ${item.detail}` : ''}`);
  }
  return failed.length === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));

if (!edge) {
  console.error('no Edge or Chrome found for the UI test');
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'lm-gw-ui-'));
let browser = null;
let socket = null;

try {
  console.log(`browser: ${edge}`);
  browser = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,1200',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  await waitForDebugger();
  const opened = await openPage();
  socket = opened.socket;
  const page = opened.page;

  // Load the panel. The cache-buster matters: the browser is fresh, but the gateway may have
  // set a caching header, and testing a stale app.js would be worse than not testing.
  await page.send('Page.navigate', { url: `${GATEWAY}/?uitest=${Date.now()}` });
  // Poll for the first render rather than waiting a fixed time: the page polls /api/status
  // itself and there is no reliable "ready" event exposed to the outside.
  const rendered = await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(300);
      try {
        const count = await page.evaluate('document.querySelectorAll(".card").length');
        if (count > 0) return count;
      } catch {
        // Page still navigating.
      }
    }
    return 0;
  })();

  section('1. the page loads and renders');
  check('no uncaught exceptions on load', page.pageErrors.length === 0,
    page.pageErrors.slice(0, 2).join(' | '));
  check('no console errors on load', page.consoleErrors.length === 0,
    page.consoleErrors.slice(0, 2).join(' | '));
  check('resource cards rendered', rendered > 0, `${rendered} cards`);
  check('gateway is connected', await page.evaluate(
    'document.getElementById("conn-text").textContent.includes("已连接")',
  ), 'conn-text');

  section('2. header shows gateway facts');
  const facts = await page.evaluate(`({
    uptime: document.getElementById('gw-uptime').textContent,
    queue: document.getElementById('gw-queue').textContent,
  })`);
  check('uptime is a clock, not a dash', /^\d+:\d\d(:\d\d)?$/.test(facts.uptime), `uptime="${facts.uptime}"`);
  check('queue depth is shown', facts.queue.length > 0, `queue="${facts.queue}"`);

  section('3. capability routing is visible');
  const routes = await page.evaluate(`Array.from(document.querySelectorAll('.route')).map(function (row) {
    return {
      cap: row.querySelector('.route__cap').textContent,
      target: row.querySelector('.route__target').textContent,
      disabled: row.classList.contains('route--off'),
    };
  })`);
  check('a row per capability', routes.length === 3, `${routes.length} rows: ${routes.map((r) => r.cap).join(', ')}`);
  check('each row names a target', routes.every((row) => row.target && row.target.length > 0),
    routes.map((row) => `${row.cap}->${row.target}`).join(' '));

  // Cross-check against the API: the panel must show the router's answer, not its own guess.
  const apiRouting = await (await fetch(`${GATEWAY}/api/status`)).json();
  const apiSpeak = apiRouting.routing?.speak?.resource;
  const uiSpeak = (routes.find((row) => row.cap === 'speak') || {}).target;
  check('the panel agrees with /api/status', apiSpeak === undefined || apiSpeak === uiSpeak,
    `api=${apiSpeak} ui=${uiSpeak}`);

  section('4. each card shows what it can do');
  const capsOk = await page.evaluate(`Array.from(document.querySelectorAll('.card')).every(function (card) {
    return card.querySelectorAll('.cap').length > 0;
  })`);
  check('every card has at least one capability chip', capsOk, 'caps');

  const cardCaps = await page.evaluate(`Array.from(document.querySelectorAll('.card')).map(function (card) {
    return {
      id: card.getAttribute('data-resource-id'),
      caps: Array.from(card.querySelectorAll('.cap')).map(function (c) { return c.textContent; }),
    };
  })`);
  const apiCaps = Object.fromEntries((apiRouting.resources ?? []).map((r) => [r.id, r.capabilities ?? []]));
  const mismatch = cardCaps.filter((card) => {
    const expected = apiCaps[card.id] ?? [];
    return expected.length !== card.caps.length;
  });
  check('chip counts match /api/status capabilities', mismatch.length === 0,
    mismatch.map((card) => `${card.id}: ui=${card.caps.join('+')} want=${(apiCaps[card.id] ?? []).join('+')}`).join(', '));

  section('5. timestamps are readable');
  const stamps = await page.evaluate(`Array.from(document.querySelectorAll('.timers span')).map(function (el) {
    return el.textContent;
  })`);
  // The old format put the clock before the date ("21:07:37 2026/10/28"). Any timestamp that
  // still leads with a time followed by a date is the regression coming back.
  const backwards = stamps.filter((text) => /\d{2}:\d{2}:\d{2}\s+\d{4}\//.test(text));
  check('no clock-before-date timestamps', backwards.length === 0, backwards.join(' | '));

  section('6. disabled resources are not dressed as errors');
  const disabledCards = await page.evaluate(`Array.from(document.querySelectorAll('.card')).filter(function (card) {
    return card.classList.contains('card--disabled');
  }).map(function (card) {
    return {
      id: card.getAttribute('data-resource-id'),
      badge: card.querySelector('.card__state').className,
    };
  })`);
  const redBadges = disabledCards.filter((card) => card.badge.includes('badge--off'));
  check('no disabled card uses the error badge', redBadges.length === 0,
    redBadges.map((card) => card.id).join(', '));

  section('6b. warnings do not contradict each other');
  // A card blocked by its exclusive group is refused for that reason. Adding "显存不足" beside
  // it misleads, and the VRAM number churns every two seconds because it is a consequence of
  // whatever else is resident rather than the obstacle. Measured in the first version: breeze
  // and anima showed both lines at once.
  const noteTexts = await page.evaluate(`Array.from(document.querySelectorAll('.card')).map(function (card) {
    var note = card.querySelector('[data-f="note"]');
    return {
      id: card.getAttribute('data-resource-id'),
      hidden: !note || note.hidden,
      text: note ? note.textContent : '',
    };
  })`);
  const contradictory = noteTexts.filter((note) => /同组资源/.test(note.text) && /显存不足/.test(note.text));
  check('a group-blocked card does not also claim VRAM shortage', contradictory.length === 0,
    contradictory.map((note) => `${note.id}: ${note.text.slice(0, 80)}`).join(' | '));
  check('hidden notes render no text', noteTexts.every((note) => !note.hidden || note.text === ''),
    noteTexts.filter((note) => note.hidden && note.text).map((note) => note.id).join(', '));

  if (DYNAMIC) {
    section('7. busy state is shown and stop is flagged (dynamic)');
    // Put a real graph in flight so backendBusy is genuinely true, then inspect the card.
    //
    // Everything else is stopped first. Without that the run fails on VRAM rather than
    // reaching the busy state - measured: memory holding 1200 MiB left 4496 MiB usable
    // against image's 5500 MiB need, so the start was refused and backendBusy never became
    // true. The test then reported a UI failure for what was really a full card.
    const target = process.env.BUSY_RESOURCE ?? 'image';
    const statusNow = await (await fetch(`${GATEWAY}/api/status`)).json();
    for (const resource of statusNow.resources ?? []) {
      if (resource.id === target) continue;
      if (resource.running !== true) continue;
      console.log(`  freeing VRAM: stopping ${resource.id}`);
      await fetch(`${GATEWAY}/api/resources/${resource.id}/stop`, { method: 'POST' });
    }

    const started = await fetch(`${GATEWAY}/api/resources/${target}/start`, { method: 'POST' });
    const startBody = await started.json();
    check('the target started, so busy state is reachable', startBody?.ok === true,
      JSON.stringify(startBody?.error ?? 'ok').slice(0, 90));

    const graph = {
      1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_int8_convrot.safetensors', weight_dtype: 'default' } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_w4a8.safetensors', type: 'qwen_image' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
      4: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt: 'ui test', negative_prompt: '', resolution: 512 } },
      5: {
        class_type: 'KSampler',
        inputs: {
          model: ['1', 0], positive: ['4', 0], negative: ['4', 1], latent_image: ['4', 2],
          seed: 100000 + (Date.now() % 800000), steps: 25, cfg: 1.0,
          sampler_name: 'euler', scheduler: 'simple', denoise: 1.0,
        },
      },
      6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['3', 0] } },
    };
    const submitted = await (await fetch(`${GATEWAY}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph }),
    })).json();

    // Wait for the page's own poll to pick the state up.
    let busySeen = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      busySeen = await page.evaluate(`(function () {
        var card = document.querySelector('[data-resource-id="${target}"]');
        if (!card) return null;
        var working = card.querySelector('[data-f="working"]');
        var stop = card.querySelector('[data-act="stop"]');
        return {
          workingVisible: working && !working.hidden,
          workingText: working ? working.textContent : '',
          stopRisky: stop ? stop.classList.contains('is-risky') : false,
        };
      })()`);
      if (busySeen?.workingVisible) break;
    }

    check('a working card says so', busySeen?.workingVisible === true,
      busySeen ? busySeen.workingText.slice(0, 70) : 'card not found');
    check('the stop button is marked risky while working', busySeen?.stopRisky === true,
      `stopRisky=${busySeen?.stopRisky}`);

    // The safety behaviour itself: pressing stop mid-generation must ask first. Accepting the
    // dialog would actually stop the service, so the test dismisses it - which also proves the
    // "no" path works, since the card must go on reporting busy afterwards.
    //
    // The click is deliberately not awaited. `Runtime.evaluate` does not return while a native
    // confirm() is open, because the page's JavaScript is suspended - awaiting it before
    // answering the dialog deadlocks the whole test. Measured: the first version hung until the
    // outer timeout. Answer the dialog first, then collect the click result.
    const dialogPromise = page.waitForDialog(6_000);
    const clickPromise = page
      .evaluate(`document.querySelector('[data-resource-id="${target}"] [data-act="stop"]').click()`)
      .catch(() => null);

    const dialog = await dialogPromise;
    check('stopping mid-generation asks for confirmation', dialog !== null,
      dialog ? `type=${dialog.type}` : 'no dialog appeared');
    if (dialog) {
      check('the confirmation says the work will be discarded',
        /中断|无法恢复/.test(dialog.message), dialog.message.replace(/\n/g, ' ').slice(0, 80));
      await page.answerDialog(false);
    }
    await clickPromise;

    if (dialog) {
      // After declining, the resource must still be working and still running.
      await sleep(1500);
      const survived = await page.evaluate(`(function () {
        var card = document.querySelector('[data-resource-id="${target}"]');
        var working = card.querySelector('[data-f="working"]');
        var stop = card.querySelector('[data-act="stop"]');
        return { workingVisible: working && !working.hidden, stopDisabled: stop ? stop.disabled : null };
      })()`);
      check('declining the confirmation leaves it running', survived.workingVisible === true
        && survived.stopDisabled !== true,
        `working=${survived.workingVisible} stopDisabled=${survived.stopDisabled}`);
    }

    if (SHOT) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log(`\nscreenshot: ${SHOT}`);
    }

    // Let it finish so the machine is not left generating.
    console.log(`\nwaiting for ${submitted.prompt_id ?? 'the graph'} to finish ...`);
    const done = Date.now() + 300_000;
    while (Date.now() < done) {
      await sleep(3000);
      const history = await (await fetch(`${GATEWAY}/history/${submitted.prompt_id}`)).json();
      const entry = history?.[submitted.prompt_id];
      if (entry?.status?.completed === true || entry?.status?.status_str === 'error') break;
    }
  } else if (SHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\nscreenshot: ${SHOT}`);
  }

  process.exitCode = finish();
} catch (error) {
  console.error(`\nUI test failed to run: ${error?.message ?? error}`);
  process.exitCode = 2;
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  try { browser?.kill(); } catch { /* already gone */ }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked; harmless */ }
}