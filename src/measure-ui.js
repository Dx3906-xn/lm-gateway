/**
 * Measure the rendered panel and report layout defects that a screenshot cannot prove.
 *
 * A screenshot shows that something looks off; it cannot say by how much, or whether the
 * cause is a stretched grid row, a fixed height, or an overflowing child. This dumps the
 * numbers so the fix targets the actual cause.
 *
 * Usage: node src/measure-ui.js
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((candidate) => existsSync(candidate));

if (!EDGE) {
  console.error('no browser found');
  process.exit(2);
}

const GATEWAY = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const PORT = Number(process.env.CDP_PORT ?? 9444);
const WIDTH = Number(process.env.VIEW_WIDTH ?? 1400);
const HEIGHT = Number(process.env.VIEW_HEIGHT ?? 1200);

const profile = mkdtempSync(join(tmpdir(), 'lm-gw-measure-'));
const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });

let socket = null;
try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) break;
    } catch { /* not up */ }
    await sleep(200);
  }

  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: `${GATEWAY}/?m=${Date.now()}` });

  // Wait for the first render.
  const ready = Date.now() + 20_000;
  while (Date.now() < ready) {
    await sleep(300);
    try {
      if (await evaluate('document.querySelectorAll(".card").length > 0')) break;
    } catch { /* navigating */ }
  }

  const report = await evaluate(`(function () {
    var cards = Array.from(document.querySelectorAll('.card'));
    var box = function (el) {
      var r = el.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) };
    };

    // Group cards by their top edge: same top means same grid row, and a row is where
    // heights are supposed to match.
    var rows = {};
    cards.forEach(function (card) {
      var b = box(card);
      var key = String(b.top);
      (rows[key] = rows[key] || []).push({
        id: card.getAttribute('data-resource-id'),
        height: b.height,
        width: b.width,
        noteVisible: !!card.querySelector('[data-f="note"]:not([hidden])'),
        workingVisible: !!card.querySelector('[data-f="working"]:not([hidden])'),
      });
    });

    // Anything wider than the viewport means a horizontal scrollbar, which usually means a
    // child cannot shrink.
    var doc = document.documentElement;
    var overflowX = doc.scrollWidth > doc.clientWidth + 1;
    var culprits = [];
    if (overflowX) {
      cards.forEach(function (card) {
        if (card.scrollWidth > card.clientWidth + 1) {
          culprits.push(card.getAttribute('data-resource-id'));
        }
      });
    }

    // Text clipped inside a card: scrollWidth beyond clientWidth on any child.
    var clipped = [];
    cards.forEach(function (card) {
      Array.from(card.querySelectorAll('*')).forEach(function (el) {
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          clipped.push(card.getAttribute('data-resource-id') + '/' + (el.className || el.tagName));
        }
      });
    });

    return {
      viewWidth: doc.clientWidth,
      docScrollWidth: doc.scrollWidth,
      overflowX: overflowX,
      overflowCulprits: culprits,
      rows: rows,
      clipped: clipped.slice(0, 10),
      cardsAreaHeight: Math.round(document.querySelector('.cards').getBoundingClientRect().height),
    };
  })()`);

  console.log('viewport width:', report.viewWidth);
  console.log('doc scroll width:', report.docScrollWidth);
  console.log('horizontal overflow:', report.overflowX ? 'YES' : 'no');
  if (report.overflowCulprits.length) console.log('  culprits:', report.overflowCulprits.join(', '));
  console.log('cards area height:', report.cardsAreaHeight);
  console.log();
  console.log('rows (cards sharing a top edge must share a height):');
  let unequal = 0;
  for (const [top, items] of Object.entries(report.rows)) {
    const heights = items.map((item) => item.height);
    const same = Math.max(...heights) - Math.min(...heights) <= 1;
    if (!same) unequal += 1;
    console.log(`  top=${top}px  ${same ? 'equal' : 'UNEQUAL'}  ${items.map((item) => item.id + '=' + item.height + 'px').join(', ')}`);
  }
  console.log();
  console.log('clipped text:', report.clipped.length ? report.clipped.join(', ') : 'none');

  if (process.env.SHOT_PATH) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(process.env.SHOT_PATH, Buffer.from(shot.data, 'base64'));
    console.log('\nscreenshot:', process.env.SHOT_PATH);
  }

  const problems = [];
  if (unequal > 0) problems.push(`${unequal} row(s) with unequal card heights`);
  if (report.overflowX) problems.push('horizontal overflow');
  if (report.clipped.length) problems.push('clipped text');

  console.log();
  console.log(problems.length ? `PROBLEMS: ${problems.join('; ')}` : 'layout: clean');
  process.exitCode = problems.length ? 1 : 0;
} finally {
  try { socket?.close(); } catch { /* gone */ }
  try { browser.kill(); } catch { /* gone */ }
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}