/* lm-gateway 控制面板 —— 纯原生 JS，无依赖、无构建步骤
 *
 * 契约：docs/DESIGN.md §6（HTTP API）与 §8（WebUI 要求）
 *   GET  /api/status                 全部状态（master / gpu / resources / queue）
 *   POST /api/master                 { enabled: bool }
 *   POST /api/resources/:id          { enabled?: bool, keepAliveSec?: int }
 *   POST /api/resources/:id/start    手动拉起
 *   POST /api/resources/:id/stop     手动停止
 */
(function () {
  'use strict';

  var POLL_MS = 2000;

  // Timeout for the 2-second status poll. Short on purpose: a poll that has not answered
  // in a few seconds means the gateway is in trouble, and waiting longer only delays the
  // "网关未启动" banner.
  var TIMEOUT_MS = 5000;

  // Timeout for control actions. These are NOT quick: 启动 a resource blocks until the
  // service answers, and ComfyUI needs 30-70 seconds to load a model. A single 5-second
  // budget for both kinds of request made the start button report "无法连接网关" while the
  // backend was starting perfectly well - a scary error for a normal operation, and it
  // left the user thinking they had to retry.
  var ACTION_TIMEOUT_MS = 240000;

  var PATHS = {
    status: '/api/status',
    master: '/api/master'
  };

  var STATE_TEXT = {
    idle: '空闲',
    starting: '启动中',
    ready: '就绪',
    busy: '忙碌',
    stopping: '停止中',
    disabled: '已禁用'
  };

  var STATE_BADGE = {
    idle: 'badge',
    starting: 'badge',
    ready: 'badge badge--on',
    busy: 'badge badge--on',
    stopping: 'badge',
    disabled: 'badge badge--off'
  };

  var ui = {};
  var locks = {};              // 'master' | resource id -> true（操作进行中）
  var latest = null;           // 最近一次 /api/status
  var cards = {};              // id -> card 对象
  var cardOrder = [];
  var online = false;
  var inFlight = false;
  var pollTimer = null;
  var toastTimer = null;
  var tickTimer = null;

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function apiResource(id) {
    return '/api/resources/' + encodeURIComponent(id);
  }

  function fmtMiB(mib) {
    if (typeof mib !== 'number' || !isFinite(mib)) return '—';
    return Math.round(mib) + ' MiB';
  }

  /**
   * Which resources share this resource's backend port.
   *
   * Three of the five resources drive ComfyUI on 8188, and that is by design rather
   * than a mistake: a port can only have one listener, so those three are declared
   * mutually exclusive and only one can be up at a time. Showing a bare "8188" on all
   * three read as a misconfiguration, so the card says how many share it and lists
   * them on hover.
   *
   * @param {object} resource - one entry from /api/status.
   * @returns {string[]} ids sharing that port, sorted, empty when not shared.
   */
  function sharedPortMembers(resource) {
    var all = (latest && Array.isArray(latest.resources)) ? latest.resources : [];
    if (resource.port === null || resource.port === undefined) return [];
    return all
      .filter(function (other) { return other && other.port === resource.port; })
      .map(function (other) { return other.id; })
      .sort();
  }

  function pct(part, total) {
    if (typeof part !== 'number' || typeof total !== 'number' || total <= 0) return 0;
    var v = (part / total) * 100;
    if (!isFinite(v) || v < 0) v = 0;
    return Math.min(100, v);
  }

  function setWidth(el, percent) {
    if (!el) return;
    el.style.width = percent.toFixed(2) + '%';
  }

  function fmtDuration(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return null;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return h > 0 ? (h + ':' + two(m) + ':' + two(s)) : (two(m) + ':' + two(s));
  }

  /* lastUsedAt 契约未规定格式：兼容 epoch(秒/毫秒) 与 ISO 字符串 */
  function fmtTime(ts) {
    if (ts === null || ts === undefined || ts === '') return '—';
    var d;
    if (typeof ts === 'number') {
      d = new Date(ts < 1e12 ? ts * 1000 : ts);
    } else {
      var n = Number(ts);
      d = (isFinite(n) && String(ts).trim() !== '') ? new Date(n < 1e12 ? n * 1000 : n) : new Date(ts);
    }
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + d.toLocaleDateString('zh-CN');
  }

  function stateText(state) {
    return STATE_TEXT[state] || (state ? String(state) : '未知');
  }

  /* 409 的 reason：契约 §5 写 "disabled"，后端实现为 "resource"（独立开关）
     或 "master"（总控）——两种都认，未知值原样附带。 */
  var REASON_TEXT = {
    disabled: '该资源独立开关已关，拒绝拉起',
    resource: '该资源独立开关已关，拒绝拉起',
    master: '总控已关，拒绝拉起',
    'master-disabled': '总控已关，拒绝拉起',
    'no-room': '显存不足，无法拉起'
  };

  function describeHttpError(status, payload) {
    var reason = '';
    var detail = '';
    if (payload && typeof payload === 'object') {
      reason = payload.reason || '';
      detail = payload.error || payload.message || '';
    } else if (typeof payload === 'string') {
      detail = payload;
    }

    var head;
    if (status === 409) head = '被拒绝（409）';
    else if (status === 404) head = '接口或资源不存在（404）';
    else if (status === 400) head = '请求不合法（400）';
    else if (status === 503) head = '资源不足（503）';
    else if (status >= 500) head = '网关内部错误（' + status + '）';
    else head = '请求失败（' + status + '）';

    var parts = [head];
    if (REASON_TEXT[reason]) parts.push(REASON_TEXT[reason]);
    else if (reason) parts.push(reason);

    if (status === 503 && payload && typeof payload === 'object' &&
        typeof payload.needMiB === 'number' && typeof payload.haveMiB === 'number') {
      parts.push('需要 ' + payload.needMiB + ' MiB，可用 ' + payload.haveMiB + ' MiB');
    }
    if (detail && detail !== reason) parts.push(detail);
    return parts.join('：');
  }

  function toast(text, kind) {
    if (!ui.toast) return;
    ui.toast.textContent = text;
    ui.toast.className = 'toast' + (kind ? ' toast--' + kind : '');
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.hidden = true; },
      kind === 'error' ? 6000 : 2500);
  }

  /* ------------------------------------------------------------------ *
   * HTTP
   * ------------------------------------------------------------------ */

  /**
   * One HTTP call.
   *
   * `timeoutMs` defaults to the poll budget, because most calls are polls. Control actions
   * pass the longer one: starting a model legitimately takes a minute, and treating that as
   * a transport failure is how a working start produced an error dialog.
   */
  function request(method, url, body, timeoutMs) {
    var budget = timeoutMs || TIMEOUT_MS;
    var opts = { method: method, cache: 'no-store' };
    var ctrl = null;
    var timer = null;
    if (typeof AbortController === 'function') {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, budget);
    }
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (text) {
        var payload = null;
        if (text) {
          try { payload = JSON.parse(text); } catch (e) { payload = null; }
        }
        if (!res.ok) {
          var err = new Error(describeHttpError(res.status, payload));
          err.kind = 'http';
          err.status = res.status;
          throw err;
        }
        return payload;
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      var err = new Error('无法连接网关（127.0.0.1:8790）');
      err.kind = 'network';
      err.cause = e;
      throw err;
    });
  }

  /* ------------------------------------------------------------------ *
   * 轮询
   * ------------------------------------------------------------------ */

  function schedule() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { poll(); }, POLL_MS);
  }

  function pollNow() {
    if (inFlight) return Promise.resolve();
    inFlight = true;
    return request('GET', PATHS.status).then(function (data) {
      inFlight = false;
      setConnection(true);
      render(data);
    }, function (err) {
      inFlight = false;
      setConnection(false, err);
    });
  }

  function poll() {
    return pollNow().then(schedule, schedule);
  }

  function setConnection(isOnline, err) {
    var was = online;
    online = !!isOnline;
    if (ui.banner) {
      ui.banner.hidden = online;
      if (!online) {
        ui.banner.className = 'banner banner--offline';
        ui['banner-title'].textContent = '网关未启动';
        ui['banner-detail'].textContent =
          '无法连接 ' + PATHS.status + (err && err.kind === 'http' ? '（' + err.message + '）' : '') +
          '。请先启动网关；本页每 2 秒自动重试。';
      }
    }
    if (ui['conn-dot']) ui['conn-dot'].className = 'dot ' + (online ? 'dot--on' : 'dot--off');
    if (ui['conn-text']) ui['conn-text'].textContent = online ? '已连接' : '未连接';
    if (ui['cards-empty']) {
      ui['cards-empty'].hidden = online && latest !== null && cardOrder.length > 0;
      ui['cards-empty'].textContent = online
        ? '暂无资源（/api/status 的 resources 为空）'
        : '网关未启动，无法获取资源列表。';
    }
    if (!online && was) {
      // 掉线时把非主按钮置灰，避免误操作
      Object.keys(cards).forEach(function (id) { syncButtons(cards[id], null); });
    }
  }

  /* ------------------------------------------------------------------ *
   * 显存
   * ------------------------------------------------------------------ */

  function renderGpu(gpu) {
    var failed = !!gpu && gpu.ok === false;
    var total = gpu && typeof gpu.totalMiB === 'number' ? gpu.totalMiB : null;
    var used = gpu && typeof gpu.usedMiB === 'number' ? gpu.usedMiB : null;
    var free = gpu && typeof gpu.freeMiB === 'number' ? gpu.freeMiB : null;
    var usable = gpu && typeof gpu.usableMiB === 'number' ? gpu.usableMiB : null;

    ui['gpu-total'].textContent = failed
      ? '显存读取失败（nvidia-smi 不可用）'
      : (total === null || total <= 0 ? '显存数据不可用' : '总量 ' + fmtMiB(total));
    ui['gpu-used'].textContent = fmtMiB(used);
    ui['gpu-usable'].textContent = fmtMiB(usable);

    // headroom 优先用后端给的 headroomMiB，缺失时回落到 free - usable
    var headroom = (gpu && typeof gpu.headroomMiB === 'number')
      ? gpu.headroomMiB
      : ((free !== null && usable !== null) ? Math.max(0, free - usable) : null);
    ui['gpu-headroom'].textContent = headroom === null ? '—' : fmtMiB(headroom);

    if (total === null || total <= 0) {
      setWidth(ui['gpu-seg-used'], 0);
      setWidth(ui['gpu-seg-usable'], 0);
      setWidth(ui['gpu-seg-headroom'], 0);
      return;
    }
    setWidth(ui['gpu-seg-used'], pct(used === null ? 0 : used, total));
    setWidth(ui['gpu-seg-usable'], pct(usable === null ? 0 : usable, total));
    setWidth(ui['gpu-seg-headroom'], pct(headroom === null ? 0 : headroom, total));
  }

  /* ------------------------------------------------------------------ *
   * 卡片
   * ------------------------------------------------------------------ */

  var CARD_HTML = [
    '<div class="card__head">',
    '  <div>',
    '    <div class="card__title" data-f="title">—</div>',
    '    <div class="card__id" data-f="id">—</div>',
    '  </div>',
    '  <span class="card__state badge" data-f="state">—</span>',
    '</div>',
    '<div class="meta">',
    '  <span class="meta__item">端口 <b data-f="port">—</b></span>',
    '  <span class="meta__item">显存 <b data-f="vram">—</b></span>',
    '  <span class="meta__item">优先级 <b data-f="priority">—</b></span>',
    '</div>',
    '<div class="timers">',
    '  <span data-f="uptime">未运行</span>',
    '  <span data-f="keepalive">—</span>',
    '  <span data-f="lastused">最近使用 —</span>',
    '</div>',
    '<div class="note" data-f="note" hidden></div>',
    '<div class="card__error" data-f="error" hidden></div>',
    '<div class="card__row">',
    '  <label class="switch" title="独立开关：关＝立即停止，此后拒绝拉起">',
    '    <input type="checkbox" data-f="enabled">',
    '    <span class="switch__track"><span class="switch__knob"></span></span>',
    '    <span class="switch__label">启用</span>',
    '  </label>',
    '  <button type="button" class="btn--start" data-act="start" data-f="start">拉起</button>',
    '  <button type="button" class="btn--stop" data-act="stop" data-f="stop">停止</button>',
    '</div>',
    '<div class="card__row">',
    '  <label class="keepalive">保持时间(秒)',
    '    <input type="number" step="1" min="-1" data-f="keepalive-input" title="整数：0 = 用完立即停，-1 = 常驻">',
    '  </label>',
    '  <span class="hint">0 = 用完立即停，-1 = 常驻</span>',
    '</div>'
  ].join('\n');

  function ensureCard(id, label) {
    var card = cards[id];
    if (card) return card;

    var el = document.createElement('div');
    el.className = 'card card--idle';
    el.setAttribute('data-resource-id', id);
    el.innerHTML = CARD_HTML;

    var refs = {};
    Array.prototype.forEach.call(el.querySelectorAll('[data-f]'), function (node) {
      refs[node.getAttribute('data-f')] = node;
    });

    card = { id: id, el: el, refs: refs, data: null, lock: false, remain: null,
      seenRunning: null, startedAt: null };
    cards[id] = card;
    cardOrder.push(id);
    ui.cards.appendChild(el);
    return card;
  }

  function removeMissingCards(present) {
    cardOrder.slice().forEach(function (id) {
      if (present[id]) return;
      var card = cards[id];
      if (card && card.el && card.el.parentNode) card.el.parentNode.removeChild(card.el);
      delete cards[id];
      cardOrder.splice(cardOrder.indexOf(id), 1);
    });
  }

  function syncButtons(card, masterOn) {
    if (!card) return;
    var r = card.data || {};
    var locked = !!card.lock || !online || !masterOn;
    var running = r.running === true;
    var busyState = r.state === 'starting' || r.state === 'stopping';

    if (card.refs.start) card.refs.start.disabled = locked || running || busyState;
    if (card.refs.stop) card.refs.stop.disabled = locked || !running;
    if (card.refs.enabled) card.refs.enabled.disabled = !!card.lock || !online;
  }

  function uptimeBase(card) {
    if (typeof card.startedAt === 'number' && isFinite(card.startedAt)) return card.startedAt;
    if (typeof card.seenRunning === 'number' && isFinite(card.seenRunning)) return card.seenRunning;
    return null;
  }

  function updateCard(card, r, masterOn) {
    card.data = r;
    var el = card.el;
    var refs = card.refs;
    var state = r.state || (r.running ? 'ready' : 'idle');
    var stateClass = STATE_TEXT[state] ? state : 'idle';

    el.className = 'card card--' + stateClass + (r.enabled === false ? ' card--off' : '');

    refs.title.textContent = r.label || r.id || card.id;
    refs.id.textContent = r.id || card.id;
    refs.state.className = 'card__state ' + (STATE_BADGE[state] || 'badge');
    refs.state.textContent = stateText(state);

    // 端口展示要区分"后端进程端口"和"对外调用端口"，否则三个共用 8188 的资源
    // 看起来像配置错误。共用不是错误：监听同一个端口的服务只能有一个进程，所以
    // image/anima/breeze 通过 exclusiveGroup 互斥，同一时刻只有一个能占用它。
    var backendPort = (r.port === null || r.port === undefined) ? null : String(r.port);
    var sharedWith = sharedPortMembers(r);
    if (backendPort === null) {
      refs.port.textContent = '—';
    } else if (sharedWith.length > 1) {
      // 显示"8188（3 个资源共用）"并把成员列在悬停提示里。
      refs.port.textContent = backendPort + '（' + sharedWith.length + ' 个共用）';
      refs.port.title = '后端进程端口。以下资源互斥使用它：' + sharedWith.join('、') +
        '\n任一时刻只有一个在运行。对外调用请用 8790。';
    } else {
      refs.port.textContent = backendPort;
      refs.port.title = '后端进程端口。对外调用请用 8790（/api/...）';
    }
    refs.vram.textContent = fmtMiB(r.vramMiB);
    refs.priority.textContent = (r.priority === null || r.priority === undefined) ? '—' : String(r.priority);

    // 运行时长：§8 要求显示，但 §6 未定义对应字段。后端 /api/status 实际提供
    // startedAt（epoch ms，可为 null）——优先用它；缺失时回落到前端观测到的 running 起点。
    if (r.running === true) {
      if (typeof r.startedAt === 'number' && isFinite(r.startedAt)) {
        card.startedAt = r.startedAt;
        card.seenRunning = null;
      } else if (card.seenRunning === null) {
        card.seenRunning = Date.now();
      }
    } else {
      card.startedAt = null;
      card.seenRunning = null;
    }
    refs.uptime.textContent = r.running === true
      ? '已运行 ' + (fmtDuration((Date.now() - uptimeBase(card)) / 1000) || '00:00')
      : '未运行';

    // keepAlive 倒计时：以后端 keepAliveRemainingSec 为基准，前端做秒级递减
    card.remain = (typeof r.keepAliveRemainingSec === 'number')
      ? { value: r.keepAliveRemainingSec, at: Date.now() }
      : null;
    refs.keepalive.textContent = keepAliveText(r, card.remain ? card.remain.value : null);

    refs.lastused.textContent = '最近使用 ' + fmtTime(r.lastUsedAt);

    var notes = [];
    if (!online) notes.push('网关未连接');
    else if (masterOn === false) notes.push('总控已关，无法拉起');
    if (r.enabled === false) notes.push('独立开关已关，拒绝拉起');
    if (r.yielded === true) notes.push('已让位：为其他资源腾出显存，不再自动重启');
    refs.note.hidden = notes.length === 0;
    refs.note.textContent = notes.join('；');

    if (r.lastError) {
      refs.error.hidden = false;
      refs.error.textContent = '最近错误：' + r.lastError;
    } else {
      refs.error.hidden = true;
      refs.error.textContent = '';
    }

    if (refs.enabled && document.activeElement !== refs.enabled) {
      refs.enabled.checked = r.enabled !== false;
    }

    if (refs['keepalive-input']) {
      var input = refs['keepalive-input'];
      if (document.activeElement !== input && !input.classList.contains('is-dirty')) {
        input.value = (typeof r.keepAliveSec === 'number') ? String(r.keepAliveSec) : '';
      }
    }

    syncButtons(card, masterOn);
  }

  function keepAliveText(r, remaining) {
    var ka = r.keepAliveSec;
    if (ka === -1) return '保持时间 常驻';
    if (ka === 0) return '保持时间 用完立即停';
    if (remaining !== null && remaining !== undefined && remaining > 0) {
      var d = fmtDuration(Math.ceil(remaining)) || '0:00';
      return (r.running === true || r.state === 'busy' || r.state === 'ready')
        ? '保持中 ' + d
        : '保持时间 ' + ka + ' 秒';
    }
    if (typeof ka === 'number') return '保持时间 ' + ka + ' 秒';
    return '保持时间 —';
  }

  function tick() {
    Object.keys(cards).forEach(function (id) {
      var card = cards[id];
      if (!card.data) return;
      var r = card.data;
      if (r.running === true) {
        var base = uptimeBase(card);
        if (base !== null) {
          card.refs.uptime.textContent = '已运行 ' + (fmtDuration((Date.now() - base) / 1000) || '00:00');
        }
      }
      if (card.remain) {
        var left = card.remain.value - (Date.now() - card.remain.at) / 1000;
        if (left < 0) left = 0;
        card.refs.keepalive.textContent = keepAliveText(r, left);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 队列 / 错误
   * ------------------------------------------------------------------ */

  function renderQueue(queue) {
    var list = Array.isArray(queue) ? queue : [];
    ui.queue.textContent = '';
    ui['queue-count'].textContent = list.length + ' 个等待中';
    ui['queue-empty'].hidden = list.length > 0;

    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'qrow';

      var idEl = document.createElement('span');
      idEl.className = 'qrow__id';
      idEl.textContent = item && item.id !== undefined ? String(item.id) : '?';

      var resEl = document.createElement('span');
      resEl.className = 'qrow__res';
      resEl.textContent = item && item.resource ? String(item.resource) : '—';

      var priEl = document.createElement('span');
      priEl.textContent = '优先级 ' + (item && item.priority !== undefined ? String(item.priority) : '—');

      var waitEl = document.createElement('span');
      waitEl.className = 'qrow__wait';
      var w = item && typeof item.waitingMs === 'number' ? item.waitingMs : null;
      waitEl.textContent = w === null ? '等待 —' : '等待 ' + (w < 1000 ? w + ' ms' : (w / 1000).toFixed(1) + ' s');

      row.appendChild(idEl);
      row.appendChild(resEl);
      row.appendChild(priEl);
      row.appendChild(waitEl);
      ui.queue.appendChild(row);
    });
  }

  function renderErrors(resources) {
    ui.errors.textContent = '';
    var withErr = resources.filter(function (r) { return r && r.lastError; });
    ui['errors-empty'].hidden = withErr.length > 0;
    withErr.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'erow';
      var name = document.createElement('b');
      name.textContent = (r.label || r.id || '资源') + '：';
      row.appendChild(name);
      row.appendChild(document.createTextNode(String(r.lastError)));
      ui.errors.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ *
   * 主渲染
   * ------------------------------------------------------------------ */

  /* master 字段容错：§6 样例是 bool，§4 的 config 里 master 是 {enabled} 对象，两种都接受 */
  function masterEnabled(v) {
    if (v === undefined || v === null) return true;
    if (typeof v === 'object') return v.enabled !== false;
    return v !== false;
  }

  function currentMasterOn() {
    return masterEnabled(latest ? latest.master : undefined);
  }

  function render(data) {
    latest = (data && typeof data === 'object') ? data : {};

    var masterOn = currentMasterOn();
    if (ui['master-toggle'] && !locks.master) ui['master-toggle'].checked = masterOn;
    if (ui['master-state']) {
      ui['master-state'].textContent = latest.master === undefined ? '未知' : (masterOn ? '已开启' : '已关闭');
      ui['master-state'].className = 'badge ' + (masterOn ? 'badge--on' : 'badge--off');
    }

    renderGpu(latest.gpu);

    var resources = Array.isArray(latest.resources) ? latest.resources : [];
    var present = {};
    resources.forEach(function (r) { if (r && r.id) present[r.id] = true; });
    removeMissingCards(present);

    resources.forEach(function (r) {
      if (!r || !r.id) return;
      var card = ensureCard(r.id);
      updateCard(card, r, masterOn);
    });

    var runningCount = resources.filter(function (r) { return r && r.running === true; }).length;
    var enabledCount = resources.filter(function (r) { return r && r.enabled !== false; }).length;
    ui['resources-summary'].textContent =
      resources.length + ' 项 · 已启用 ' + enabledCount + ' · 运行中 ' + runningCount;

    if (ui['cards-empty']) {
      ui['cards-empty'].hidden = resources.length > 0;
      ui['cards-empty'].textContent = resources.length > 0 ? '' : '暂无资源（/api/status 的 resources 为空）';
    }

    renderQueue(latest.queue);
    renderErrors(resources);
  }

  /* ------------------------------------------------------------------ *
   * 操作
   * ------------------------------------------------------------------ */

  function lock(key) { locks[key] = true; }
  function unlock(key) { delete locks[key]; }

  function perform(key, requestFn, okMsg, card) {
    lock(key);
    if (card) syncButtons(card, currentMasterOn());
    else if (ui['master-toggle']) ui['master-toggle'].disabled = true;

    return requestFn().then(function () {
      if (okMsg) toast(okMsg, 'ok');
    }, function (err) {
      toast(err && err.message ? err.message : '操作失败', 'error');
    }).then(function () {
      unlock(key);
      if (ui['master-toggle']) ui['master-toggle'].disabled = false;
      return pollNow();
    }).then(function () {
      if (card) syncButtons(card, currentMasterOn());
    });
  }

  function toggleMaster(enabled) {
    if (locks.master) return;
    perform('master', function () {
      // Turning the master switch off stops every service, which can take a while; on
      // takes effect immediately.
      return request('POST', PATHS.master, { enabled: !!enabled }, enabled ? TIMEOUT_MS : ACTION_TIMEOUT_MS);
    }, enabled ? '总控已开启' : '总控已关闭（全部拒绝拉起并停止）');
  }

  function toggleResource(card, enabled) {
    if (card.lock) return;
    card.lock = true;
    syncButtons(card, currentMasterOn());
    perform('res:' + card.id, function () {
      return request('POST', apiResource(card.id), { enabled: !!enabled });
    }, enabled ? '已启用：' + card.id : '已关闭：' + card.id + '（将立即停止）', card).then(function () {
      card.lock = false;
      syncButtons(card, currentMasterOn());
    });
  }

  function startResource(card) {
    if (card.lock) return;
    card.lock = true;
    syncButtons(card, currentMasterOn());
    perform('res:' + card.id, function () {
      return request('POST', apiResource(card.id) + '/start', undefined, ACTION_TIMEOUT_MS);
    }, '已拉起：' + card.id, card).then(function () {
      card.lock = false;
      syncButtons(card, currentMasterOn());
    });
  }

  function stopResource(card) {
    if (card.lock) return;
    card.lock = true;
    syncButtons(card, currentMasterOn());
    perform('res:' + card.id, function () {
      return request('POST', apiResource(card.id) + '/stop', undefined, ACTION_TIMEOUT_MS);
    }, '已停止：' + card.id, card).then(function () {
      card.lock = false;
      syncButtons(card, currentMasterOn());
    });
  }

  function commitKeepAlive(card, input) {
    input.classList.remove('is-dirty');
    if (card.lock) { restoreKeepAlive(card, input); return; }
    var raw = String(input.value).trim();
    if (raw === '') { restoreKeepAlive(card, input); return; }

    var val = Number(raw);
    if (!isFinite(val) || Math.floor(val) !== val) {
      toast('保持时间必须是整数（-1 或 ≥ 0 的秒数）', 'error');
      restoreKeepAlive(card, input);
      return;
    }
    if (val < -1) {
      toast('保持时间不能小于 -1（-1 表示常驻）', 'error');
      restoreKeepAlive(card, input);
      return;
    }
    var r = card.data || {};
    if (typeof r.keepAliveSec === 'number' && r.keepAliveSec === val) return;

    card.lock = true;
    syncButtons(card, currentMasterOn());
    perform('res:' + card.id, function () {
      return request('POST', apiResource(card.id), { keepAliveSec: val });
    }, '保持时间已保存：' + card.id + ' = ' + val + ' 秒', card).then(function () {
      card.lock = false;
      syncButtons(card, currentMasterOn());
    });
  }

  function restoreKeepAlive(card, input) {
    var r = card.data || {};
    input.value = (typeof r.keepAliveSec === 'number') ? String(r.keepAliveSec) : '';
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  function findCard(node) {
    var el = node;
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains('card')) return cards[el.getAttribute('data-resource-id')];
      el = el.parentNode;
    }
    return null;
  }

  function bind() {
    if (ui['master-toggle']) {
      ui['master-toggle'].addEventListener('change', function () {
        toggleMaster(this.checked);
      });
    }

    ui.cards.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!btn) return;
      var card = findCard(btn);
      if (!card) return;
      var act = btn.getAttribute('data-act');
      if (act === 'start') startResource(card);
      else if (act === 'stop') stopResource(card);
    });

    ui.cards.addEventListener('change', function (ev) {
      var t = ev.target;
      var card = findCard(t);
      if (!card) return;
      if (t.getAttribute('data-f') === 'enabled') {
        toggleResource(card, t.checked);
      } else if (t.getAttribute('data-f') === 'keepalive-input') {
        commitKeepAlive(card, t);
      }
    });

    ui.cards.addEventListener('input', function (ev) {
      var t = ev.target;
      if (t.getAttribute && t.getAttribute('data-f') === 'keepalive-input') {
        t.classList.add('is-dirty');
      }
    });

    ui.cards.addEventListener('keydown', function (ev) {
      var t = ev.target;
      if (ev.key === 'Enter' && t.getAttribute && t.getAttribute('data-f') === 'keepalive-input') {
        ev.preventDefault();
        t.blur();
      }
    });

    // 离开输入框即提交（change 已覆盖），blur 时清理 dirty 标记
    ui.cards.addEventListener('blur', function (ev) {
      var t = ev.target;
      if (t.getAttribute && t.getAttribute('data-f') === 'keepalive-input') {
        t.classList.remove('is-dirty');
      }
    }, true);
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function boot() {
    ['banner', 'banner-title', 'banner-detail', 'master-toggle', 'master-state',
     'conn-dot', 'conn-text', 'gpu-total', 'gpu-seg-used', 'gpu-seg-usable',
     'gpu-seg-headroom', 'gpu-used', 'gpu-usable', 'gpu-headroom', 'cards',
     'cards-empty', 'resources-summary', 'queue', 'queue-count', 'queue-empty',
     'errors', 'errors-empty', 'toast'
    ].forEach(function (id) { ui[id] = $(id); });

    if (!ui.cards) return; // 页面结构缺失时安静退出，不留白屏异常

    bind();
    poll();
    tickTimer = setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();