// ==UserScript==
// @name          SAP Kontrollscan
// @namespace    local.sap.kontrollscan.stop.lite
// @version      8.9.3
// @description  Lite: indicator + highlight + toast + beep on new/increased errors + ToCount<0 first + row-level fallback + gated Weitere + SPA-safe teardown. No settings.
// @match        https://vhfiwp61ci.sap.ugfischer.com:44300/*
// @match        http://localhost:8000/kontrollscan.html
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Skrap87/SAP-Helper/main/Kontrolle/main/SAP_Kontrollscan_LITE.js
// @downloadURL  https://raw.githubusercontent.com/Skrap87/SAP-Helper/main/Kontrolle/main/SAP_Kontrollscan_LITE.js
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== SPA / DOUBLE INIT GUARD ===================== */

  const GUARD_KEY = '__kcKontrollscanLite__';
  try {
    if (window[GUARD_KEY] && typeof window[GUARD_KEY].teardown === 'function') {
      window[GUARD_KEY].teardown('reinit');
    }
  } catch (_) {}

  /* ===================== CONFIG ===================== */

  const ERROR_PATTERNS = [
    /mengendifferenz/i,
    /mengendifferenz\s+vorhanden/i,
    /differenz\s+.*menge/i,
    /menge\s+.*differenz/i,
    /quantity\s+difference/i,
    /difference\s+in\s+quantity/i,
    /qty\s+difference/i,
  ];

  // Tick pacing
  const FAST_TICK_MS = 750;   // когда есть ошибки/движуха
  const SLOW_TICK_MS = 900;   // когда спокойно

  // Beep anti-spam
  const MIN_BEEP_GAP_MS = 800;

  // Observer throttle
  const OBS_THROTTLE_MS = 250;

  // User busy window (не трогаем Weitere)
  const USER_BUSY_MS = 900;

  // Weitere ramp (только когда контроль начат)
  const RAMP_WINDOW_MS = 4000;
  const RAMP_TRY_EVERY_MS = 650;
  const RAMP_MAX_TRIES = 6;
  const RAMP_MIN_GAP_MS = 650;
  const RAMP_NO_GROW_STOP_AFTER = 4;

  // Highlight style (фиксированно)
  const HIGHLIGHT_FILL = 'rgba(255, 0, 0, 0.08)';
  const HIGHLIGHT_OUTLINE = 'rgba(255, 0, 0, 0.25)';

  /* ===================== SELECTORS ===================== */

  const SELECTORS = {
    pageHuControl: ['[id$="--pageHuControl"]'],
    titleHuControl: ['[id$="--titleTableHuControl"]'],
    titleHuControlInner: ['[id$="--titleTableHuControl-inner"]'],

    // HU items table root
    tableHuItemsExact: ['[id$="--tableHuItems"]'],
    tableHuItemsLoose: ['[id*="--tableHuItems"]'],

    // Rows + content
    tableRows: ['tr.sapMListTblRow'],
    toCountTextInRow: ['[id*="--objectNumberQuanToCount"] .sapMObjectNumberText'],
    statusTextInRow: ['.sapMObjStatusText'],

    // “Weitere” growing trigger
    weitereTriggerList: ['[id$="--tableHuItems-triggerList"]'],
    weitereTrigger: ['[id$="--tableHuItems-trigger"]'],
    weitereTriggerText: ['[id$="--tableHuItems-triggerText"]'],
    weitereTriggerInfo: ['[id$="--tableHuItems-triggerInfo"]'],

    // Our UI
    ourUiRoots: ['#kcLiteUiLayer', '#kcLiteToast', '#kcLiteStyle'],
  };

  function q1(sel) { return document.querySelector(sel); }
  function qAll(sel) { return Array.from(document.querySelectorAll(sel)); }
  function findFirst(selectors) {
    for (const s of selectors) {
      const el = q1(s);
      if (el) return el;
    }
    return null;
  }

  /* ===================== STATE ===================== */

  const now = () => Date.now();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  let destroyed = false;

  // timers / observer
  let tickTimer = null;
  let obs = null;
  let obsTarget = null;

  // user activity
  let userBusyUntil = 0;
  function bumpUserBusy() { userBusyUntil = now() + USER_BUSY_MS; }
  function isUserBusy() { return now() < userBusyUntil; }

  // UI
  let indicatorEl = null;
  let toastEl = null;

  // audio
  let lastBeepAt = 0;
  let audioCtx = null;
  let audioUnlocked = false;

  // ramp “Weitere”
  let rampActive = false;
  let rampActiveUntil = 0;
  let rampTries = 0;
  let rampTimer = null;
  let lastWeitereAt = 0;
  let rampNoGrowStreak = 0;
  let lastRowCountSeen = 0;

  // scanning novelty
  let hasActiveErrorNow = false;
  let lastActiveErrorCount = 0; // чтобы НЕ пищать при уменьшении, пока ошибки остаются
  let lastSignature = '';

  // cache
  let scanCache = {
    rows: [],
    toCountNodesByRow: new Map(), // tr -> nodes[]
    builtAt: 0
  };
  let tableDirty = true;

  /* ===================== STABLE ROW KEY (v8.8.4 idea) ===================== */

  function stableRowKey(tr) {
    if (!tr) return 'row:null';

    // 1) Material обычно в колонке aria-colindex="3" (как у тебя)
    const matCell = tr.querySelector('td[aria-colindex="3"]');
    if (matCell) {
      const spans = matCell.querySelectorAll('.sapMText');
      for (const sp of spans) {
        const t = norm(sp.textContent || '');
        if (/^\d{3,}$/.test(t)) return `MAT:${t}`;
      }
    }

    // 2) fallback: любой sapMText с цифрами
    const all = tr.querySelectorAll('.sapMText');
    for (const sp of all) {
      const t = norm(sp.textContent || '');
      if (/^\d{3,}$/.test(t)) return `MAT:${t}`;
    }

    // 3) последний fallback
    const raw = norm(tr.innerText || tr.textContent || '');
    return `T:${raw.slice(0, 80)}`;
  }

  /* ===================== CSS ===================== */

  function injectStyle() {
    if (document.getElementById('kcLiteStyle')) return;

    const css = document.createElement('style');
    css.id = 'kcLiteStyle';
    css.textContent = `
      .kcLiteRowErr{
        background: ${HIGHLIGHT_FILL} !important;
        box-shadow: inset 0 0 0 2px ${HIGHLIGHT_OUTLINE} !important;
      }

      #kcLiteUiLayer{
        position: fixed;
        top: 14px;
        right: 240px;
        z-index: 99999;
        pointer-events: none;
      }
      #kcLiteIndicator{
        pointer-events: auto;
        font-size: 18px;
        cursor: default;
        user-select: none;
        opacity: 0.32;
        transition: opacity .15s ease, transform .15s ease;
        line-height: 1;
      }
      #kcLiteIndicator:hover{ opacity:0.85; transform:translateY(-1px); }

      #kcLiteToast{
        pointer-events: auto;
        position: fixed;
        left: 50%;
        top: 10px;
        transform: translateX(-50%);
        z-index: 2147483647;
        background: rgba(0,0,0,0.88);
        color: #fff;
        font: 14px system-ui, Segoe UI, Arial;
        padding: 14px 16px;
        border-radius: 14px;
        box-shadow: 0 12px 26px rgba(0,0,0,0.35);
        backdrop-filter: blur(6px);
        max-width: 520px;
        width: max-content;
        display: none;
      }
      #kcLiteToast .title{font-weight:700;margin-bottom:6px;}
      #kcLiteToast .small{opacity:.85;font-size:13px;margin-top:8px;}
      #kcLiteToast .row{display:flex;gap:10px;align-items:flex-start;}
      #kcLiteToast .btn{
        margin-left:auto;
        cursor:pointer;
        border:0;
        border-radius:10px;
        padding:6px 10px;
        background:rgba(255,255,255,0.15);
        color:#fff;
      }
      #kcLiteToast .btn:hover{background:rgba(255,255,255,0.24);}
    `;
    document.documentElement.appendChild(css);
  }

  /* ===================== UI ===================== */

  function ensureUiLayer() {
    let layer = document.getElementById('kcLiteUiLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'kcLiteUiLayer';
      document.documentElement.appendChild(layer);
    }
    return layer;
  }

  function ensureIndicator() {
    if (indicatorEl) return;
    const layer = ensureUiLayer();

    indicatorEl = document.createElement('div');
    indicatorEl.id = 'kcLiteIndicator';
    indicatorEl.title = 'SAP Kontrollscan LITE aktiv';
    indicatorEl.textContent = '⚪';
    layer.appendChild(indicatorEl);

    // клик по индикатору показывает toast, если есть ошибки
    indicatorEl.addEventListener('click', () => {
      if (!hasActiveErrorNow) return;
      ensureToast();
      toastEl.style.display = 'block';
    });
  }

  function ensureToast() {
    if (toastEl) return;
    toastEl = document.createElement('div');
    toastEl.id = 'kcLiteToast';
    toastEl.innerHTML = `
      <div class="row">
        <div>⚠️</div>
        <div style="flex:1;">
          <div class="title">Fehler erkannt</div>
          <div>STOP – letzten Scan prüfen</div>
          <div id="kcLiteCount" class="small"></div>
        </div>
        <button id="kcLiteOk" class="btn" type="button">OK</button>
      </div>
    `;
    document.documentElement.appendChild(toastEl);

    toastEl.querySelector('#kcLiteOk')?.addEventListener('click', () => {
      toastEl.style.display = 'none';
    });
  }

  function showToast(activeCount, sourceLabel) {
    ensureToast();
    const el = toastEl.querySelector('#kcLiteCount');
    if (el) el.textContent = `Aktive Fehler: ${activeCount}${sourceLabel ? ' · ' + sourceLabel : ''}`;
    toastEl.style.display = 'block';
  }

  function hideToast() {
    if (toastEl) toastEl.style.display = 'none';
  }

  function setIndicator(sym) {
    ensureIndicator();
    indicatorEl.textContent = sym;
  }

  /* ===================== AUDIO (one fixed beep) ===================== */

  function ensureAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
    try { audioCtx = new Ctx(); return audioCtx; } catch (_) { audioCtx = null; return null; }
  }

  async function unlockAudioIfNeeded() {
    if (audioUnlocked) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      audioUnlocked = (ctx.state === 'running');
    } catch (_) {}
  }

  function playBeep() {
    const t = now();
    if (t - lastBeepAt < MIN_BEEP_GAP_MS) return;
    lastBeepAt = t;

    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') return;

    try {
      const gain = ctx.createGain();
      gain.gain.value = 0.22; // фиксированно
      gain.connect(ctx.destination);

      function tone(freq, durMs, startDelayMs) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        o.connect(gain);

        const startAt = ctx.currentTime + (startDelayMs / 1000);
        const stopAt = startAt + (durMs / 1000);
        o.start(startAt);
        o.stop(stopAt);
      }

      // classic pattern
      tone(700, 150, 0);
      tone(500, 180, 180);
      tone(700, 150, 400);
      tone(500, 180, 580);
    } catch (_) {}
  }

  function setupAudioUnlockHooks() {
    const once = async () => {
      await unlockAudioIfNeeded();
      window.removeEventListener('pointerdown', once, true);
      window.removeEventListener('keydown', once, true);
      window.removeEventListener('touchstart', once, true);
    };
    window.addEventListener('pointerdown', once, true);
    window.addEventListener('keydown', once, true);
    window.addEventListener('touchstart', once, true);
  }

  async function closeAudioCtx() {
    const ctx = audioCtx;
    audioCtx = null;
    audioUnlocked = false;
    if (!ctx) return;
    try { if (ctx.state !== 'closed') await ctx.close(); } catch (_) {}
  }

  /* ===================== PAGE / STATE DETECTION ===================== */

  function isOnHuPage() {
    return !!findFirst(SELECTORS.pageHuControl) || !!findFirst(SELECTORS.titleHuControl) || !!findFirst(SELECTORS.titleHuControlInner);
  }

  function getHuTable() {
    return findFirst(SELECTORS.tableHuItemsExact) || findFirst(SELECTORS.tableHuItemsLoose);
  }

  // упрощённо: “контроль начат” = таблица есть и есть строки
  function isControlStarted() {
    const table = getHuTable();
    if (!table) return false;
    const rows = qAll(SELECTORS.tableRows[0]);
    return rows.length > 0;
  }

  /* ===================== PARSE HELPERS ===================== */

  function parseLocaleNumber(txt) {
    const s = norm(txt);
    if (!s) return { ok: false, val: NaN };

    // оставим цифры/знак/разделители
    let t = s.replace(/[^\d\-.,]/g, '');

    // кейс: "-0,15" -> "-0.15"
    // кейс: "1.234,56" -> "1234.56"
    // кейс: "1,234.56" -> "1234.56"
    const lastComma = t.lastIndexOf(',');
    const lastDot = t.lastIndexOf('.');

    if (lastComma !== -1 && lastDot !== -1) {
      // два разделителя: считаем, что последний — десятичный
      if (lastComma > lastDot) {
        // comma decimal
        t = t.replace(/\./g, '');
        t = t.replace(',', '.');
      } else {
        // dot decimal
        t = t.replace(/,/g, '');
      }
    } else if (lastComma !== -1) {
      // только запятая -> десятичная
      t = t.replace(',', '.');
    } // только точка -> ок

    const val = Number(t);
    if (!Number.isFinite(val)) return { ok: false, val: NaN };
    return { ok: true, val };
  }

  function matchesErrorText(text) {
    const t = norm(text);
    if (!t) return false;
    for (const re of ERROR_PATTERNS) {
      if (re.test(t)) return true;
    }
    return false;
  }

  /* ===================== SCAN CACHE ===================== */

  function rebuildCacheIfNeeded() {
    const t = now();
    if (!tableDirty && (t - scanCache.builtAt) < 600) return;

    const rows = qAll(SELECTORS.tableRows[0]);
    const map = new Map();
    for (const tr of rows) {
      const nodes = Array.from(tr.querySelectorAll(SELECTORS.toCountTextInRow[0]));
      map.set(tr, nodes);
    }

    scanCache = { rows, toCountNodesByRow: map, builtAt: t };
    tableDirty = false;
  }

  /* ===================== ERROR SCAN ===================== */

  function clearHighlights() {
    const rows = scanCache.rows || [];
    for (const tr of rows) tr.classList.remove('kcLiteRowErr');
  }

  function scanErrors() {
    rebuildCacheIfNeeded();

    const rows = scanCache.rows;
    if (!rows || rows.length === 0) {
      clearHighlights();
      return { activeCount: 0, signature: '', source: '' };
    }

    const hits = []; // {key, tr}
    let source = '';

    for (const tr of rows) {
      const nodes = scanCache.toCountNodesByRow.get(tr) || [];
      let anyParsed = false;
      let anyParseFail = false;
      let rowIsError = false;

      // 1) ToCount < 0
      for (const n of nodes) {
        const r = parseLocaleNumber(n.textContent || '');
        if (r.ok) {
          anyParsed = true;
          if (r.val < 0) {
            rowIsError = true;
            source = source || 'Zum Nachzählen';
            break;
          }
        } else {
          anyParseFail = true;
        }
      }

      // 2) row-level fallback по статусу — ТОЛЬКО если в этой строке что-то не распарсилось
      if (!rowIsError && anyParseFail) {
        const st = tr.querySelector(SELECTORS.statusTextInRow[0]);
        const stText = norm(st?.textContent || '');
        if (matchesErrorText(stText)) {
          rowIsError = true;
          source = source || 'Status-Fallback';
        }
      }

      if (rowIsError) {
        hits.push({ key: stableRowKey(tr), tr });
      }
    }

    // highlight
    clearHighlights();
    for (const h of hits) h.tr.classList.add('kcLiteRowErr');

    // signature: sorted stable keys
    const keys = hits.map(h => h.key).sort();
    const signature = keys.join('|');

    return { activeCount: hits.length, signature, source };
  }

  /* ===================== WEITERE (gated) ===================== */

  function parseXofY(text) {
    const t = norm(text);
    // ищем [x/y] или x/y
    const m = t.match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  function getWeitereTrigger() {
    // иногда текст/инфо в разных местах
    const trigger = findFirst(SELECTORS.weitereTrigger) || findFirst(SELECTORS.weitereTriggerList);
    const t1 = findFirst(SELECTORS.weitereTriggerText);
    const t2 = findFirst(SELECTORS.weitereTriggerInfo);

    const label = norm((t1?.textContent || '') + ' ' + (t2?.textContent || '') + ' ' + (trigger?.textContent || ''));
    return { el: trigger, label };
  }

  function shouldTryWeitere() {
    if (isUserBusy()) return false;
    if (!rampActive) return false;
    if (now() > rampActiveUntil) return false;
    if (rampTries >= RAMP_MAX_TRIES) return false;

    const { el, label } = getWeitereTrigger();
    if (!el) return false;

    const xy = parseXofY(label);
    if (!xy) return false;

    // грузим только если x<y
    if (xy.x >= xy.y) return false;

    // защита по частоте
    if (now() - lastWeitereAt < RAMP_MIN_GAP_MS) return false;

    return true;
  }

  function doWeitereOnce() {
    const table = getHuTable();
    if (!table) return;

    const rowsNow = qAll(SELECTORS.tableRows[0]).length;
    if (lastRowCountSeen === 0) lastRowCountSeen = rowsNow;

    const { el } = getWeitereTrigger();
    if (!el) return;

    try {
      lastWeitereAt = now();
      rampTries += 1;
      el.click();
    } catch (_) {}

    // проверка “выросло/не выросло”
    setTimeout(() => {
      const rowsAfter = qAll(SELECTORS.tableRows[0]).length;
      if (rowsAfter > lastRowCountSeen) {
        lastRowCountSeen = rowsAfter;
        rampNoGrowStreak = 0;
      } else {
        rampNoGrowStreak += 1;
      }

      if (rampNoGrowStreak >= RAMP_NO_GROW_STOP_AFTER) {
        stopRamp();
      }
    }, 450);
  }

  function scheduleRampTick() {
    if (rampTimer) clearTimeout(rampTimer);
    rampTimer = setTimeout(() => {
      if (destroyed) return;
      if (shouldTryWeitere()) doWeitereOnce();
      if (rampActive && now() <= rampActiveUntil && rampTries < RAMP_MAX_TRIES) {
        scheduleRampTick();
      }
    }, RAMP_TRY_EVERY_MS);
  }

  function startRamp() {
    rampActive = true;
    rampActiveUntil = now() + RAMP_WINDOW_MS;
    rampTries = 0;
    rampNoGrowStreak = 0;
    lastRowCountSeen = 0;
    scheduleRampTick();
  }

  function stopRamp() {
    rampActive = false;
    rampActiveUntil = 0;
    rampTries = 0;
    rampNoGrowStreak = 0;
    lastRowCountSeen = 0;
    if (rampTimer) clearTimeout(rampTimer);
    rampTimer = null;
  }

  /* ===================== MAIN TICK ===================== */

  function tick() {
    if (destroyed) return;

    injectStyle();
    ensureIndicator();

    // ⚪ вне HU страницы — ничего не делаем
    if (!isOnHuPage()) {
      setIndicator('⚪');
      hasActiveErrorNow = false;
      hideToast();
      clearHighlights();
      stopRamp();
      scheduleNext(SLOW_TICK_MS);
      return;
    }

    // 🟡 на HU, но контроль не начат — ошибки не ищем
    if (!isControlStarted()) {
      setIndicator('🟡');
      hasActiveErrorNow = false;
      hideToast();
      clearHighlights();
      stopRamp();
      scheduleNext(SLOW_TICK_MS);
      return;
    }

    // 🟢 контроль начат
    setIndicator('🟢');

    // стартуем ramp “Weitere” только в GREEN
    if (!rampActive) startRamp();

    // скан ошибок
    const { activeCount, signature, source } = scanErrors();
    hasActiveErrorNow = activeCount > 0;

    if (hasActiveErrorNow) {
      setIndicator('🔴');
      showToast(activeCount, source);

      // beep logic:
      // - пищим если:
      //   a) ошибок стало больше
      //   b) ошибок столько же, но сигнатура поменялась (заменились строки)
      // - НЕ пищим если ошибок стало меньше, пока activeCount > 0
      const increased = activeCount > lastActiveErrorCount;
      const replacedSameCount = (activeCount === lastActiveErrorCount) && signature && (signature !== lastSignature);

      if (increased || replacedSameCount) {
        if (audioUnlocked) {
          playBeep();
        } else {
          // если звук ещё не разблокирован — просто не пищим (первый клик пользователя всё равно разблокирует)
        }
      }

      lastActiveErrorCount = activeCount;
      lastSignature = signature || lastSignature;

      scheduleNext(FAST_TICK_MS);
      return;
    }

    // нет ошибок -> зелёный режим
    lastActiveErrorCount = 0;
    lastSignature = '';

    hideToast();
    scheduleNext(SLOW_TICK_MS);
  }

  function scheduleNext(ms) {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, ms);
  }

  /* ===================== OBSERVER ===================== */

  function isOurUiNode(node) {
    if (!(node instanceof Element)) return false;
    for (const sel of SELECTORS.ourUiRoots) {
      try { if (node.closest(sel)) return true; } catch (_) {}
    }
    return false;
  }

  function setupObserver() {
    if (obs) return;

    obs = new MutationObserver(() => {
      if (destroyed) return;
      const t = now();
      if (t - (setupObserver._last || 0) < OBS_THROTTLE_MS) return;
      setupObserver._last = t;
      tableDirty = true;
    });

    // target = HU table (если есть), иначе body
    obsTarget = getHuTable() || document.body;
    try {
      obs.observe(obsTarget, { childList: true, subtree: true, characterData: true });
    } catch (_) {}
  }

  function retargetObserverIfNeeded() {
    if (!obs) return;
    const t = getHuTable() || document.body;
    if (t === obsTarget) return;
    try { obs.disconnect(); } catch (_) {}
    obsTarget = t;
    try {
      obs.observe(obsTarget, { childList: true, subtree: true, characterData: true });
    } catch (_) {}
  }

  /* ===================== USER BUSY HOOKS ===================== */

  function setupUserBusyHooks() {
    const onBusy = (e) => {
      if (destroyed) return;
      // игнорим клики по нашему UI
      if (e && e.target && isOurUiNode(e.target)) return;
      bumpUserBusy();
    };

    window.addEventListener('pointerdown', onBusy, true);
    window.addEventListener('wheel', onBusy, { passive: true, capture: true });
    window.addEventListener('keydown', onBusy, true);

    setupUserBusyHooks._onBusy = onBusy;
  }

  function removeUserBusyHooks() {
    const onBusy = setupUserBusyHooks._onBusy;
    if (!onBusy) return;
    try { window.removeEventListener('pointerdown', onBusy, true); } catch (_) {}
    try { window.removeEventListener('wheel', onBusy, true); } catch (_) {}
    try { window.removeEventListener('keydown', onBusy, true); } catch (_) {}
    setupUserBusyHooks._onBusy = null;
  }

  /* ===================== TEARDOWN ===================== */

  async function teardown(reason = 'manual') {
    if (destroyed) return;
    destroyed = true;

    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = null;

    stopRamp();

    if (obs) {
      try { obs.disconnect(); } catch (_) {}
      obs = null;
      obsTarget = null;
    }

    removeUserBusyHooks();

    // remove UI
    try { document.getElementById('kcLiteUiLayer')?.remove(); } catch (_) {}
    try { document.getElementById('kcLiteToast')?.remove(); } catch (_) {}
    try { document.getElementById('kcLiteStyle')?.remove(); } catch (_) {}

    await closeAudioCtx();

    // cleanup guard
    try { if (window[GUARD_KEY]) delete window[GUARD_KEY]; } catch (_) {}
  }

  // expose for reinit guard
  window[GUARD_KEY] = { teardown };

  /* ===================== BOOT ===================== */

  function boot() {
    injectStyle();
    ensureIndicator();
    setupObserver();
    setupUserBusyHooks();
    setupAudioUnlockHooks();

    // teardown on navigation
    const onPageHide = () => teardown('pagehide');
    const onBeforeUnload = () => teardown('beforeunload');
    window.addEventListener('pagehide', onPageHide, true);
    window.addEventListener('beforeunload', onBeforeUnload, true);

    // store handlers to remove if needed
    boot._onPageHide = onPageHide;
    boot._onBeforeUnload = onBeforeUnload;

    // main loop
    tick();

    // observer retarget in case UI5 swaps nodes
    setInterval(() => {
      if (destroyed) return;
      retargetObserverIfNeeded();
    }, 1200);
  }

  boot();
})();