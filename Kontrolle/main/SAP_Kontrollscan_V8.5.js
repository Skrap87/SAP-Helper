// ==UserScript==
// @name         SAP Kontrollscan V8
// @namespace    local.sap.kontrollscan.stop
// @version      8.5
// @description  STOP signal (Mengendifferenz) with UI5 MessageManager as truth source + optimized table scan (highlight/count) + safer ramp "Weitere" + stable indicator + safer UI + audio unlock + TABLE toast fallback.
// @match        https://vhfiwp61ci.sap.ugfischer.com:44300/*
// @match        https://vhfwp61ci.sap.ugfischer.com:44300/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== CONFIG (from audit FIX list) ===================== */

  // BUG-001/FIX-001: truth source should NOT depend on row visibility
  const ERROR_RE = /mengendifferenz vorhanden/i;

  // BUG-002/FIX-003: adaptive + gated scanning
  const FAST_TICK_MS = 250;   // when error active OR table dirty
  const SLOW_TICK_MS = 650;   // when idle
  const UI5_MSG_POLL_MS = 250; // cheap poll of message model (truth)

  // BUG-006/FIX-006: stronger anti-spam + reuse AudioContext
  const MIN_BEEP_GAP_MS = 700;

  // BUG-003/FIX-004: observer scope + throttling
  const OBS_THROTTLE_MS = 250;

  // BUG-005/FIX-005: ramp safety
  const USER_BUSY_MS = 900;
  const RAMP_WINDOW_MS = 9000;
  const RAMP_TRY_EVERY_MS = 650;
  const RAMP_MAX_TRIES = 16;
  const RAMP_MIN_GAP_MS = 450;
  const MAX_BURSTS_PER_SESSION = 40;
  const RAMP_NO_GROW_STOP_AFTER = 4; // stop if no row growth N ramp tries

  /* ===================== STATE ===================== */

  let userBusyUntil = 0;

  let rampActiveUntil = 0;
  let rampTries = 0;
  let rampTimer = null;

  let lastWeitereAt = 0;
  let burstsDone = 0;
  let weitereRunning = false;

  let toastEl = null;
  let indicatorEl = null;

  let lastBeepAt = 0;

  // Truth channel (UI5 messages)
  let lastUi5ErrSignature = '';
  let ui5ErrActive = false;

  // Table channel (highlight/count)
  let tableDirty = true;
  let lastTableSignature = '';
  let lastErrorCount = 0;

  // ✅ NEW: prevent duplicate Toast from TABLE fallback
  let lastTableToastSignature = '';

  // observers/timers
  let tickTimer = null;
  let msgTimer = null;
  let obs = null;

  // Audio reuse
  let audioCtx = null;
  let audioUnlocked = false;

  /* ===================== HELPERS ===================== */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();

  function bumpUserBusy() { userBusyUntil = now() + USER_BUSY_MS; }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function safeGetCore() {
    try { return window.sap?.ui?.getCore?.(); } catch (_) { return null; }
  }

  /* ===================== UI5 TRUTH: MessageManager (FIX-001) ===================== */

  function getUi5MessagesData() {
    const core = safeGetCore();
    if (!core) return null;

    try {
      const mm = core.getMessageManager?.();
      const model = mm?.getMessageModel?.();
      const data = model?.getData?.();
      return Array.isArray(data) ? data : null;
    } catch (_) {
      return null;
    }
  }

  function computeUi5ErrorSignature() {
    const msgs = getUi5MessagesData();
    if (!msgs) return { active: false, signature: '' };

    const hits = [];
    for (const m of msgs) {
      // typical UI5 message fields: message, description, type, text
      const msgText = norm(m?.message || m?.text || '');
      const descText = norm(m?.description || '');
      const combo = (msgText + ' ' + descText).trim();

      if (!combo) continue;

      if (ERROR_RE.test(combo)) {
        // add some stable identity if present
        const key = norm(m?.id || m?.code || '') || combo;
        hits.push(key);
      }
    }

    hits.sort();
    const signature = hits.join('||');
    return { active: hits.length > 0, signature };
  }

  /* ===================== SCREEN DETECTION (FIX-007) ===================== */

  function getHuTableIdFromTrigger() {
    const t = document.querySelector('[id$="tableHuItems-triggerText"]');
    if (!t?.id) return null;
    return t.id.replace(/--tableHuItems-triggerText$/, '--tableHuItems');
  }

  function getHuTableControl() {
    const core = safeGetCore();
    if (!core) return null;

    const id = getHuTableIdFromTrigger();
    if (id) {
      const c = core.byId?.(id);
      if (c) return c;
    }

    // fallback (still stable enough): any element containing --tableHuItems
    const any = document.querySelector('[id*="--tableHuItems"]');
    if (any?.id) {
      const c2 = core.byId?.(any.id);
      if (c2) return c2;
    }

    return null;
  }

  function isHuScreen() {
    // FIX-007: prefer table control presence, not hardcoded text
    const tableCtrl = getHuTableControl();
    if (tableCtrl) return true;

    // fallback: old heuristic (kept, but not primary)
    const spans = document.querySelectorAll('span');
    for (const s of spans) {
      const t = (s.textContent || '').trim();
      if (t === 'HU-Inhalt prüfen:' || t.startsWith('HU-Inhalt prüfen:')) return true;
    }
    return false;
  }

  function isActiveKontrolle() {
    if (!isHuScreen()) return false;

    // keep existing heuristic, but avoid global "No data" scan (BUG-008)
    // Instead: if table has too few rows, treat as inactive.
    const rows = document.querySelectorAll('tr.sapMListTblRow');
    return rows && rows.length > 2;
  }

  /* ===================== UI (FIX-008) ===================== */

  function injectStyle() {
    if (document.getElementById('kcStyle')) return;

    const css = document.createElement('style');
    css.id = 'kcStyle';
    css.textContent = `
      .kc-error-highlight{
        background: rgba(255, 0, 0, 0.08) !important;
        animation: kcPulse 1.2s infinite;
      }
      @keyframes kcPulse{
        0%   { box-shadow: inset 0 0 0 0 rgba(255,0,0,0.25); }
        50%  { box-shadow: inset 0 0 0 6px rgba(255,0,0,0.12); }
        100% { box-shadow: inset 0 0 0 0 rgba(255,0,0,0.25); }
      }

      /* container is non-blocking */
      #kcUiLayer{
        position: fixed;
        top: 14px;
        right: 240px;
        z-index: 99999;
        pointer-events: none;
      }

      /* ✅ INDICATOR (clickable only itself) */
      #kcIndicator{
        pointer-events: auto;
        width: auto;
        height: auto;
        background: transparent;
        font-size: 18px;
        cursor: pointer;
        user-select: none;
        opacity: 0.32;
        transition: opacity .15s ease, transform .15s ease;
        line-height: 1;
      }
      #kcIndicator:hover{ opacity:0.85; transform:translateY(-1px); }

      /* toast */
      #kcStopToast{
        pointer-events: auto;
        position: fixed;
        left: 50%;
        top: 10px;
        transform: translateX(-50%);
        z-index: 2147483647; /* ✅ FIX: never hidden by SAP overlays */
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
      #kcStopToast .title{font-weight:700;margin-bottom:6px;}
      #kcStopToast .small{opacity:.85;font-size:13px;margin-top:8px;}
      #kcStopToast .row{display:flex;gap:10px;align-items:flex-start;}
      #kcStopToast .btn{
        margin-left:auto;
        cursor:pointer;
        border:0;
        border-radius:10px;
        padding:6px 10px;
        background:rgba(255,255,255,0.15);
        color:#fff;
      }
      #kcStopToast .btn:hover{background:rgba(255,255,255,0.24);}
    `;
    document.documentElement.appendChild(css);
  }

  function ensureUiLayer() {
    let layer = document.getElementById('kcUiLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'kcUiLayer';
      document.documentElement.appendChild(layer);
    }
    return layer;
  }

  function ensureIndicator() {
    if (indicatorEl) return;

    const layer = ensureUiLayer();
    indicatorEl = document.createElement('div');
    indicatorEl.id = 'kcIndicator';
    indicatorEl.title = 'SAP Kontrollscan aktiv';
    indicatorEl.textContent = '⚪';
    layer.appendChild(indicatorEl);

    indicatorEl.addEventListener('click', () => {
      if (toastEl) toastEl.style.display = 'block';
    });
  }

  function updateIndicator(hasError) {
    ensureIndicator();

    if (!isHuScreen()) {
      indicatorEl.textContent = '⚪';
      return;
    }
    if (hasError) {
      indicatorEl.textContent = '🔴';
      return;
    }
    indicatorEl.textContent = isActiveKontrolle() ? '🟢' : '⚪';
  }

  function ensureToast() {
    if (toastEl) return;

    toastEl = document.createElement('div');
    toastEl.id = 'kcStopToast';
    toastEl.innerHTML = `
      <div class="row">
        <div>⚠️</div>
        <div style="flex:1;">
          <div class="title">Mengendifferenz erkannt</div>
          <div>STOP – letzten Scan prüfen</div>
          <div id="kcStopCount" class="small"></div>
        </div>
        <button id="kcStopOk" class="btn" type="button">OK</button>
      </div>
    `;
    document.documentElement.appendChild(toastEl);

    toastEl.querySelector('#kcStopOk')?.addEventListener('click', () => {
      toastEl.style.display = 'none';
    });
  }

  function showToast(activeCount, sourceLabel) {
    ensureToast();
    const el = toastEl.querySelector('#kcStopCount');
    if (el) el.textContent = `Aktive Fehler: ${activeCount}${sourceLabel ? ' · ' + sourceLabel : ''}`;
    toastEl.style.display = 'block';
  }

  /* ===================== AUDIO (FIX-006) ===================== */

  function ensureAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;

    if (audioCtx && audioCtx.state !== 'closed') return audioCtx;
    try {
      audioCtx = new Ctx();
      return audioCtx;
    } catch (_) {
      audioCtx = null;
      return null;
    }
  }

  async function unlockAudioIfNeeded() {
    if (audioUnlocked) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;

    try {
      if (ctx.state === 'suspended') await ctx.resume();
      audioUnlocked = (ctx.state === 'running');
    } catch (_) {
      // keep false
    }
  }

  function playBeep() {
    const t = now();
    if (t - lastBeepAt < MIN_BEEP_GAP_MS) return;
    lastBeepAt = t;

    const ctx = ensureAudioCtx();
    if (!ctx) return;

    // If blocked, keep visual only (toast already) — no extra behavior beyond FIX list
    if (ctx.state === 'suspended') return;

    try {
      const gain = ctx.createGain();
      gain.gain.value = 0.22;
      gain.connect(ctx.destination);

      function tone(freq, durMs, delayMs) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        o.connect(gain);
        const startAt = ctx.currentTime + (delayMs / 1000);
        const stopAt = startAt + (durMs / 1000);
        o.start(startAt);
        o.stop(stopAt);
      }

      tone(700, 150, 0);
      tone(500, 180, 180);
      tone(700, 150, 400);
      tone(500, 180, 580);
    } catch (_) {}
  }

  /* ===================== TABLE SCAN (FIX-003) ===================== */

  function computeTableSignatureAndHighlight() {
    const rows = Array.from(document.querySelectorAll('tr.sapMListTblRow'));

    const errs = [];
    for (const tr of rows) {
      const rowText = norm(tr.textContent || '');
      const isError = ERROR_RE.test(rowText);

      if (isError) {
        tr.classList.add('kc-error-highlight');
        errs.push(rowText);
      } else {
        tr.classList.remove('kc-error-highlight');
      }
    }

    errs.sort();
    return { signature: errs.join('||'), count: errs.length };
  }

  /* ===================== RAMP / WEITERE (FIX-005) ===================== */

  function ui5LoadMore(tableCtrl) {
    if (!tableCtrl) return false;

    // keep existing strategy (audit says fragile, so we add safety, not redesign)
    try {
      const d = tableCtrl._oGrowingDelegate;
      if (d) {
        if (typeof d.requestNewPage === 'function') { d.requestNewPage(); return true; }
        if (typeof d._requestNewPage === 'function') { d._requestNewPage(); return true; }
        if (typeof d.onScrollToLoad === 'function') { d.onScrollToLoad(); return true; }
      }
    } catch (_) {}

    try {
      if (typeof tableCtrl._triggerGrowing === 'function') { tableCtrl._triggerGrowing(); return true; }
      if (typeof tableCtrl.triggerGrowing === 'function') { tableCtrl.triggerGrowing(); return true; }
    } catch (_) {}

    try {
      if (typeof tableCtrl.fireGrowing === 'function') { tableCtrl.fireGrowing(); return true; }
    } catch (_) {}

    try {
      const b = (typeof tableCtrl.getBinding === 'function') ? tableCtrl.getBinding('items') : null;
      if (b && typeof b.getLength === 'function' && typeof b.getContexts === 'function') {
        const len = b.getLength();
        b.getContexts(0, Math.max(len + 40, 200));
        return true;
      }
    } catch (_) {}

    return false;
  }

  async function tryInvisibleWeitereOnce() {
    if (weitereRunning) return false;

    if (!isHuScreen()) return false;
    if (!isActiveKontrolle()) return false;

    if (now() < userBusyUntil) return false;

    if (now() - lastWeitereAt < RAMP_MIN_GAP_MS) return false;
    if (burstsDone >= MAX_BURSTS_PER_SESSION) return false;

    const table = getHuTableControl();
    if (!table) return false;

    weitereRunning = true;
    lastWeitereAt = now();
    burstsDone++;

    try {
      ui5LoadMore(table);
      await sleep(320);
      return true;
    } finally {
      // FIX-005: never get stuck
      weitereRunning = false;
    }
  }

  let rampLastRowCount = -1;
  let rampNoGrowStreak = 0;

  function ensureRampWindow() {
    const t = now();
    if (t < rampActiveUntil) return;

    rampActiveUntil = t + RAMP_WINDOW_MS;
    rampTries = 0;

    rampLastRowCount = document.querySelectorAll('tr.sapMListTblRow').length;
    rampNoGrowStreak = 0;

    scheduleRampTick(0);
  }

  function stopRamp() {
    rampActiveUntil = 0;
    rampTries = 0;
    rampNoGrowStreak = 0;
    rampLastRowCount = -1;

    if (rampTimer) { clearTimeout(rampTimer); rampTimer = null; }
  }

  function scheduleRampTick(delay) {
    if (rampTimer) return;

    rampTimer = setTimeout(async () => {
      rampTimer = null;

      if (!isActiveKontrolle()) { stopRamp(); return; }
      if (now() > rampActiveUntil) { stopRamp(); return; }
      if (rampTries >= RAMP_MAX_TRIES) { stopRamp(); return; }

      rampTries++;

      const before = document.querySelectorAll('tr.sapMListTblRow').length;
      await tryInvisibleWeitereOnce();
      const after = document.querySelectorAll('tr.sapMListTblRow').length;

      if (after <= before) rampNoGrowStreak++;
      else rampNoGrowStreak = 0;

      if (rampNoGrowStreak >= RAMP_NO_GROW_STOP_AFTER) { stopRamp(); return; }

      scheduleRampTick(RAMP_TRY_EVERY_MS);
    }, delay);
  }

  /* ===================== OBSERVER (FIX-004) ===================== */

  let lastObsAt = 0;

  function markTableDirtyThrottled() {
    const t = now();
    if (t - lastObsAt < OBS_THROTTLE_MS) return;
    lastObsAt = t;
    tableDirty = true;
  }

  function attachObserver() {
    if (obs) return;

    const target =
      document.querySelector('[id$="tableHuItems"]') ||
      document.querySelector('[id*="--tableHuItems"]') ||
      document.documentElement; // fallback

    obs = new MutationObserver(() => {
      // only mark dirty; real work is in tick
      markTableDirtyThrottled();

      // ramp window only when we are in Kontrolle
      if (isActiveKontrolle()) ensureRampWindow();
    });

    obs.observe(target, { childList: true, subtree: true });
  }

  /* ===================== CORE LOOP ===================== */

  function fireStopSignal(activeCount, sourceLabel) {
    playBeep();
    showToast(activeCount, sourceLabel);
  }

  function tick() {
    const hu = isHuScreen();

    // truth (UI5) drives indicator + stop signal
    updateIndicator(ui5ErrActive);

    // ramp
    if (hu && isActiveKontrolle()) ensureRampWindow();
    else stopRamp();

    // table scan only if needed (FIX-003)
    if (hu && (tableDirty || ui5ErrActive)) {
      tableDirty = false;

      const st = computeTableSignatureAndHighlight();
      lastErrorCount = st.count;
      lastTableSignature = st.signature;

      // ✅ FALLBACK: UI5 messages may be empty, but table clearly shows error rows
      if (st.signature && st.signature !== lastTableToastSignature) {
        lastTableToastSignature = st.signature;
        fireStopSignal(st.count || 1);
      }

      // reset when table has no errors anymore
      if (!st.signature) {
        lastTableToastSignature = '';
      }
    }

    // hide toast when no error in both channels
    // (UI5 can be silent; table is a reliable visibility fallback)
    if (!ui5ErrActive && !lastTableSignature) {
      if (toastEl) toastEl.style.display = 'none';
    }

    // adaptive scheduling
    const nextMs = (ui5ErrActive || tableDirty) ? FAST_TICK_MS : SLOW_TICK_MS;
    tickTimer = setTimeout(tick, nextMs);
  }

  function tickUi5Messages() {
    const st = computeUi5ErrorSignature();

    ui5ErrActive = st.active;

    if (!st.active) {
      lastUi5ErrSignature = '';
    } else if (st.active && st.signature && st.signature !== lastUi5ErrSignature) {
  lastUi5ErrSignature = st.signature;

  const count = (lastErrorCount > 0)
    ? lastErrorCount
    : (st.signature.split('||').filter(Boolean).length || 1);

  fireStopSignal(count, 'UI5');
}

    msgTimer = setTimeout(tickUi5Messages, UI5_MSG_POLL_MS);
  }

  /* ===================== START ===================== */

  function hookUserActivity() {
    window.addEventListener('pointerdown', (e) => { bumpUserBusy(); unlockAudioIfNeeded(); }, true);
    window.addEventListener('keydown', (e) => { bumpUserBusy(); unlockAudioIfNeeded(); }, true);
    window.addEventListener('wheel', bumpUserBusy, { passive: true, capture: true });
  }

  function start() {
    injectStyle();
    ensureIndicator();
    hookUserActivity();
    attachObserver();

    // “startup kicks” kept, but cheap: only marks dirty + ramp window via observer
    setTimeout(() => { if (isActiveKontrolle()) ensureRampWindow(); tableDirty = true; }, 700);
    setTimeout(() => { if (isActiveKontrolle()) ensureRampWindow(); tableDirty = true; }, 1600);
    setTimeout(() => { if (isActiveKontrolle()) ensureRampWindow(); tableDirty = true; }, 2600);

    // start loops
    tick();
    tickUi5Messages();
  }

  start();
})();