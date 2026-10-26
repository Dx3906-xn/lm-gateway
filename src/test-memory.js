/**
 * Verify the memory-retrieval resource end to end, including the fields its consumer
 * depends on.
 *
 * Written after a report from the code that uses this service, which found three
 * things this test now pins down:
 *
 *   - `encodeVersion` was not exposed. The consumer caches vectors keyed by the encoder
 *     version, so with no version to read it could only use a constant, and replacing
 *     the embedding model would keep answering from stale vectors - silently.
 *   - `/api/search` had no server-side deadline, so a service that died mid-request
 *     left a call that neither returned nor failed.
 *   - The start path treated a long-running service as a command that should finish,
 *     and killed it after two minutes of waiting for an exit that was never coming.
 *
 * The Chinese inputs are deliberate: they are the actual payload shape, and on this
 * machine a wrongly-encoded body arrives structurally valid but semantically garbage,
 * so the shape checks alone would not catch it.
 */

import { createReporter, callGateway, portOpen, exitWith } from './test-util.js';

const BASE = process.env.LM_GATEWAY_URL ?? 'http://127.0.0.1:8790';
const resourceId = process.argv[2] ?? 'memory';

const { check, section, finish } = createReporter('memory resource end-to-end');

const call = (method, path, body, timeoutSec) => callGateway(BASE, method, path, body, timeoutSec);

// --- 1. start and read the encoder version ---------------------------------
section('1. start');
const start = await call('POST', `/api/resources/${resourceId}/start`, undefined, 120);
check('start reports ok', start.body?.ok === true, JSON.stringify(start.body?.error ?? 'ok'));

const statusAfterStart = await call('GET', '/api/status');
const memory = statusAfterStart.body.resources.find((entry) => entry.id === resourceId);
check('resource reads ready', memory?.state === 'ready' || memory?.state === 'busy',
  `state=${memory?.state}`);

// --- 2. encodeVersion is exposed (the field the caller asked for) -----------
section('2. encodeVersion');
check('encodeVersion is present', memory?.encodeVersion != null,
  `encodeVersion=${JSON.stringify(memory?.encodeVersion)}`);
check('encodeVersion is not the placeholder', memory?.encodeVersion !== 'gateway-embed',
  String(memory?.encodeVersion));
check('info carries the encoder identity', Boolean(memory?.info?.model),
  `model=${memory?.info?.model}, dim=${memory?.info?.dim}`);

// --- 3. embedding works, and the body survived UTF-8 -----------------------
section('3. /api/search embedding');
const embedded = await call('POST', '/api/search', { texts: ['猫在睡觉', '狗在叫'] });
check('embed returns 200', embedded.status === 200, `got ${embedded.status}`);
check('two vectors returned', embedded.body?.vectors?.length === 2,
  `got ${embedded.body?.vectors?.length}`);
check('dimension matches health', embedded.body?.dim === memory?.info?.dim,
  `${embedded.body?.dim} vs ${memory?.info?.dim}`);
check('vectors are non-degenerate',
  embedded.body?.vectors?.every((vector) => new Set(vector).size > 1),
  'each vector has more than one distinct value');

// The decisive UTF-8 check: a body mangled into the wrong encoding still parses and
// still returns the right shape, so the only way to catch it is to embed two different
// strings and confirm they did not arrive as the same bytes.
const distinct = await call('POST', '/api/search', { texts: ['完全相同', '完全不同'] });
const [first, second] = distinct.body?.vectors ?? [];
check('different text gives different vectors',
  Boolean(first && second) && first.some((value, index) => value !== second[index]),
  'the two texts did not collapse to one vector');

// --- 4. ranking ------------------------------------------------------------
section('4. /api/search ranking');
const ranked = await call('POST', '/api/search', {
  query: '猫',
  candidates: ['猫在睡觉', '今天天气不错', '狗在追球'],
  topK: 2,
});
check('rank returns 200', ranked.status === 200, `got ${ranked.status}`);
check('topK respected', ranked.body?.ranked?.length === 2, `got ${ranked.body?.ranked?.length}`);
check('best match is the cat line', ranked.body?.ranked?.[0]?.text === '猫在睡觉',
  `top=${ranked.body?.ranked?.[0]?.text}`);

// --- 5. a deadline exists --------------------------------------------------
section('5. request deadline');
const deadline = await call('POST', '/api/search', { texts: ['超时测试'], timeoutSec: 1 }, 30);
// A second is enough for a warm local model. The assertion is that the call comes back
// at all - a missing deadline produced a request that neither returned nor failed.
check('a short timeout still returns a response',
  deadline.status === 200 || deadline.status === 500, `status=${deadline.status}`);

// --- 6. leave it stopped ---------------------------------------------------
section('6. stop');
const stop = await call('POST', `/api/resources/${resourceId}/stop`, undefined, 60);
check('stop reports ok', stop.body?.ok === true, JSON.stringify(stop.body?.error ?? 'ok'));
check('port released after stop', !(await portOpen(9820, 3000)), 'port 9820');

exitWith(finish());