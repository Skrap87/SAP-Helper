// ==UserScript==
// @name         SAP Kontrollscan V8.8.2 (row-level fallback for ToCount parse fail)
// @namespace    local.sap.kontrollscan.stop
// @version      8.8.2
// @description  v8.8.1 + FIX: fallback по статусу только для строки, где ToCount не распарсился (например "nn"). Не включает fallback для всей таблицы.
// @match        https://vhfiwp61ci.sap.ugfischer.com:44300/*
// @match        http://localhost:8000/kontrollscan.html
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== SPA / DOUBLE INIT GUARD ===================== */

  const GUARD_KEY = '__kcKontrollscanV88x__';
  try {
    if (window[GUARD_KEY] && typeof window[GUARD_KEY].teardown === 'function') {
      window[GUARD_KEY].teardown('reinit');
    }
  } catch (_) {}

  /* ===================== SELECTORS (P2-007) ===================== */

  const SELECTORS = {
    pageHuControl: ['[id$="--pageHuControl"]'],
    titleHuControl: ['[id$="--titleTableHuControl"]'],
    titleHuControlInner: ['[id$="--titleTableHuControl-inner"]'],

    tableHuItemsExact: ['[id$="--tableHuItems"]'],
    tableHuItemsLoose: ['[id*="--tableHuItems"]'],

    // ToCount container (ObjectNumber)
    toCountTextInRow: ['[id*="--objectNumberQuanToCount"] .sapMObjectNumberText'],

    // Row-level status text (точно то, что ты показал в DevTools)
    statusTextInRow: ['.sapMObjStatusText'],

    // “Weitere” growing trigger
    weitereTriggerList: ['[id$="--tableHuItems-triggerList"]'],
    weitereTrigger: ['[id$="--tableHuItems-trigger"]'],
    weitereTriggerText: ['[id$="--tableHuItems-triggerText"]'],
    weitereTriggerInfo: ['[id$="--tableHuItems-triggerInfo"]'],

    // Rows
    tableRows: ['tr.sapMListTblRow'],

    // Our UI (ignore in observer)
    ourUiRoots: ['#kcUiLayer', '#kcStopToast', '#kcSettings', '#kcStyle'],
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

  const FAST_TICK_MS = 350;
  const SLOW_TICK_MS = 850;

  const MIN_BEEP_GAP_MS = 800;
  const OBS_THROTTLE_MS = 250;
  const USER_BUSY_MS = 900;

  const RAMP_WINDOW_MS = 4000;
  const RAMP_TRY_EVERY_MS = 650;
  const RAMP_MAX_TRIES = 6;
  const RAMP_MIN_GAP_MS = 650;
  const MAX_BURSTS_PER_SESSION = 40;
  const RAMP_NO_GROW_STOP_AFTER = 4;

  const PULSE_MS = 850;
  const PENDING_BEEP_TTL_MS = 3500;

  const COLOR_PROFILES = {
    classic: { fill: 'rgba(255, 0, 0, 0.08)', pulseOuter: 'rgba(255, 0, 0, 0.25)', pulseInner: 'rgba(255, 0, 0, 0.12)' },
    soft:    { fill: 'rgba(255, 140, 0, 0.08)', pulseOuter: 'rgba(255, 140, 0, 0.25)', pulseInner: 'rgba(255, 140, 0, 0.12)' },
    neon:    { fill: 'rgba(180, 0, 255, 0.10)', pulseOuter: 'rgba(180, 0, 255, 0.35)', pulseInner: 'rgba(180, 0, 255, 0.18)' },
    calm:    { fill: 'rgba(0, 140, 255, 0.08)', pulseOuter: 'rgba(0, 140, 255, 0.25)', pulseInner: 'rgba(0, 140, 255, 0.12)' }
  };

  /* ===================== SETTINGS ===================== */

  const SETTINGS_KEY = 'kc_settings_v1';

  const DEFAULT_SETTINGS = {
    highlightEnabled: true,
    highlightAnimate: true,
    soundEnabled: true,
    volume: 22,
    soundPreset: 'classic',
    colorProfile: 'classic'
  };

  function clampNum(n, a, b) {
    if (!Number.isFinite(n)) return a;
    return Math.max(a, Math.min(b, n));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const obj = raw ? JSON.parse(raw) : {};
      return {
        highlightEnabled: !!(obj.highlightEnabled ?? DEFAULT_SETTINGS.highlightEnabled),
        highlightAnimate: !!(obj.highlightAnimate ?? DEFAULT_SETTINGS.highlightAnimate),
        soundEnabled: !!(obj.soundEnabled ?? DEFAULT_SETTINGS.soundEnabled),
        volume: clampNum(Number(obj.volume ?? DEFAULT_SETTINGS.volume), 0, 100),
        soundPreset: String(obj.soundPreset ?? DEFAULT_SETTINGS.soundPreset),
        colorProfile: String(obj.colorProfile ?? DEFAULT_SETTINGS.colorProfile)
      };
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
  }

  let SETTINGS = loadSettings();

  /* ===================== STATE ===================== */

  const now = () => Date.now();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  let destroyed = false;

  const HANDLERS = {
    onUserBusy: null,
    onSettingsOutsidePointerDown: null,
    onBeforeUnload: null,
    onPageHide: null,
  };

  let userBusyUntil = 0;
  function bumpUserBusy() { userBusyUntil = now() + USER_BUSY_MS; }
  function isUserBusy() { return now() < userBusyUntil; }

  let pulseOn = false;
  let pulseTimer = null;

  let rampActive = false;
  let rampActiveUntil = 0;
  let rampTries = 0;
  let rampTimer = null;
  let lastWeitereAt = 0;
  let burstsDone = 0;
  let rampNoGrowStreak = 0;
  let lastRowCountSeen = 0;
  let weitereRunning = false;

  let toastEl = null;
  let indicatorEl = null;
  let settingsEl = null;

  let lastBeepAt = 0;
  let audioCtx = null;
  let audioUnlocked = false;

  let pendingBeepAt = 0;
  let pendingBeepSig = '';

  let tableDirty = true;
  let tickTimer = null;
  let obs = null;
  let obsTarget = null;

  let lastErrorSignature = '';
  let lastErrorAt = 0;

  let toastDismissed = false;
  let hasActiveErrorNow = false;

  let scanCache = {
    builtAt: 0,
    rows: [],
    toCountNodesByRow: new Map(),
  };
  let lastFullScanAt = 0;
  const FULL_SCAN_MIN_GAP_MS = 220;

  /* ===================== COLOR APPLY ===================== */

  function applyColorProfile() {
    const p = COLOR_PROFILES[SETTINGS.colorProfile] || COLOR_PROFILES.classic;
    document.documentElement.style.setProperty('--kc-fill-color', p.fill);
    document.documentElement.style.setProperty('--kc-pulse-outer', p.pulseOuter);
    document.documentElement.style.setProperty('--kc-pulse-inner', p.pulseInner);
  }

  /* ===================== SYNC PULSE ===================== */

  function startPulseSync() {
    if (pulseTimer) return;
    pulseTimer = setInterval(() => {
      pulseOn = !pulseOn;
      document.documentElement.classList.toggle('kc-pulse-on', pulseOn);
    }, PULSE_MS);
  }

  function stopPulseSync() {
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = null;
    pulseOn = false;
    document.documentElement.classList.remove('kc-pulse-on');
  }

  /* ===================== CSS ===================== */

  function injectStyle() {
    if (document.getElementById('kcStyle')) return;

    const css = document.createElement('style');
    css.id = 'kcStyle';
    css.textContent = `
      .kc-error-highlight{ background: var(--kc-fill-color) !important; }
      .kc-anim{
        transition: box-shadow 650ms ease;
        box-shadow: inset 0 0 0 0 var(--kc-pulse-outer);
      }
      .kc-pulse-on .kc-anim{ box-shadow: inset 0 0 0 6px var(--kc-pulse-inner); }

      #kcUiLayer{
        position: fixed;
        top: 14px;
        right: 240px;
        z-index: 99999;
        pointer-events: none;
      }
      #kcIndicator{
        pointer-events: auto;
        font-size: 18px;
        cursor: default;
        user-select: none;
        opacity: 0.32;
        transition: opacity .15s ease, transform .15s ease;
        line-height: 1;
        background: transparent;
      }
      #kcIndicator:hover{ opacity:0.85; transform:translateY(-1px); }

      #kcStopToast{
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

      #kcSettings{
        pointer-events: auto;
        position: fixed;
        right: 430px;
        top: 44px;
        z-index: 2147483646;
        background: rgba(0,0,0,0.86);
        color: #fff;
        font: 13px system-ui, Segoe UI, Arial;
        padding: 10px 12px;
        border-radius: 12px;
        box-shadow: 0 12px 26px rgba(0,0,0,0.35);
        backdrop-filter: blur(6px);
        width: 290px;
        display: none;
      }
      #kcSettings .h{ display:flex; align-items:center; justify-content:space-between; margin-bottom: 8px; }
      #kcSettings .h .t{font-weight:700;}
      #kcSettings .x{
        cursor:pointer;
        border:0;
        background:transparent;
        color:#fff;
        font-size:18px;
        line-height:1;
        opacity:.85;
      }
      #kcSettings .x:hover{opacity:1;}
      #kcSettings .row{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin: 6px 0; }
      #kcSettings label{cursor:pointer; user-select:none;}
      #kcSettings input[type="checkbox"]{ transform: translateY(1px); }
      #kcSettings select, #kcSettings input[type="range"]{ width: 160px; }
      #kcSettings .small{ opacity: .78; font-size: 12px; margin-top: 8px; }
      #kcSettings .play{
        cursor:pointer;
        border:0;
        border-radius:10px;
        padding:6px 10px;
        background:rgba(255,255,255,0.15);
        color:#fff;
      }
      #kcSettings .play:hover{background:rgba(255,255,255,0.24);}
    `;
    document.documentElement.appendChild(css);
  }

  /* ===================== UI ===================== */

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
    indicatorEl.title = 'SAP Kontrollscan aktiv (Rechtsklick: Einstellungen)';
    indicatorEl.textContent = '⚪';
    layer.appendChild(indicatorEl);

    indicatorEl.addEventListener('click', () => {
      if (!hasActiveErrorNow) return;
      if (!toastEl) return;
      toastDismissed = false;
      toastEl.style.display = 'block';
    });

    indicatorEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSettings(true);
    });
  }

  function ensureToast() {
    if (toastEl) return;
    toastEl = document.createElement('div');
    toastEl.id = 'kcStopToast';
    toastEl.innerHTML = `
      <div class="row">
        <div>⚠️</div>
        <div style="flex:1;">
          <div class="title">Fehler erkannt</div>
          <div>STOP – letzten Scan prüfen</div>
          <div id="kcStopCount" class="small"></div>
        </div>
        <button id="kcStopOk" class="btn" type="button">OK</button>
      </div>
    `;
    document.documentElement.appendChild(toastEl);

    toastEl.querySelector('#kcStopOk')?.addEventListener('click', () => {
      toastEl.style.display = 'none';
      toastDismissed = true;
    });
  }

  function showToast(activeCount, sourceLabel) {
    ensureToast();
    const el = toastEl.querySelector('#kcStopCount');
    if (el) el.textContent = `Aktive Fehler: ${activeCount}${sourceLabel ? ' · ' + sourceLabel : ''}`;
    toastEl.style.display = 'block';
  }

  function hideToast() {
    if (toastEl) toastEl.style.display = 'none';
  }

  function ensureSettingsPanel() {
    if (settingsEl) return;

    settingsEl = document.createElement('div');
    settingsEl.id = 'kcSettings';
    settingsEl.innerHTML = `
      <div class="h">
        <div class="t">⚙️ Einstellungen</div>
        <button class="x" type="button" title="Schließen">×</button>
      </div>

      <div class="row">
        <span>🎨 Farbe</span>
        <select id="kcSetColor">
          <option value="classic">Classic (Rot)</option>
          <option value="soft">Soft (Orange)</option>
          <option value="neon">Neon (Violett)</option>
          <option value="calm">Calm (Blau)</option>
        </select>
      </div>

      <div class="row">
        <label><input id="kcSetHighlight" type="checkbox"> Highlight</label>
        <span style="opacity:.8;">Zeilen</span>
      </div>

      <div class="row">
        <label><input id="kcSetAnim" type="checkbox"> Animation</label>
        <span style="opacity:.8;">Pulse</span>
      </div>

      <div class="row">
        <label><input id="kcSetSound" type="checkbox"> Sound</label>
        <span style="opacity:.8;">Beep</span>
      </div>

      <div class="row">
        <span>🔊 Volume</span>
        <input id="kcSetVol" type="range" min="0" max="100" step="1">
      </div>

      <div class="row">
        <span>🎛 Signal</span>
        <select id="kcSetPreset">
          <option value="classic">Classic</option>
          <option value="short">Short</option>
          <option value="double">Double</option>
          <option value="siren">Siren</option>
          <option value="click">Click</option>
        </select>
      </div>

      <div class="row">
        <span></span>
        <button id="kcSetPlay" class="play" type="button">Play</button>
      </div>

      <div class="small">Rechtsklick auf ⚪/🟡/🟢/🔴 öffnet dieses Menü.</div>
    `;

    document.documentElement.appendChild(settingsEl);

    settingsEl.querySelector('.x')?.addEventListener('click', () => toggleSettings(false));

    const selColor = settingsEl.querySelector('#kcSetColor');
    const cbHi = settingsEl.querySelector('#kcSetHighlight');
    const cbAn = settingsEl.querySelector('#kcSetAnim');
    const cbSo = settingsEl.querySelector('#kcSetSound');
    const rgVo = settingsEl.querySelector('#kcSetVol');
    const selP = settingsEl.querySelector('#kcSetPreset');

    selColor.value = SETTINGS.colorProfile;
    cbHi.checked = SETTINGS.highlightEnabled;
    cbAn.checked = SETTINGS.highlightAnimate;
    cbSo.checked = SETTINGS.soundEnabled;
    rgVo.value = String(SETTINGS.volume);
    selP.value = SETTINGS.soundPreset;

    selColor.addEventListener('change', () => {
      SETTINGS.colorProfile = String(selColor.value || 'classic');
      saveSettings(SETTINGS);
      applyColorProfile();
    });

    cbHi.addEventListener('change', () => {
      SETTINGS.highlightEnabled = cbHi.checked;
      saveSettings(SETTINGS);
      if (!SETTINGS.highlightEnabled) clearAllHighlights();
    });

    cbAn.addEventListener('change', () => {
      SETTINGS.highlightAnimate = cbAn.checked;
      saveSettings(SETTINGS);
      if (!SETTINGS.highlightAnimate) stopPulseSync();
      refreshHighlightAnimationClass();
    });

    cbSo.addEventListener('change', async () => {
      SETTINGS.soundEnabled = cbSo.checked;
      saveSettings(SETTINGS);
      if (SETTINGS.soundEnabled) await unlockAudioIfNeeded();
    });

    rgVo.addEventListener('input', () => {
      SETTINGS.volume = clampNum(Number(rgVo.value), 0, 100);
      saveSettings(SETTINGS);
    });

    selP.addEventListener('change', () => {
      SETTINGS.soundPreset = String(selP.value || 'classic');
      saveSettings(SETTINGS);
    });

    settingsEl.querySelector('#kcSetPlay')?.addEventListener('click', async () => {
      await unlockAudioIfNeeded();
      playBeep(true);
    });

    HANDLERS.onSettingsOutsidePointerDown = (e) => {
      if (!settingsEl || settingsEl.style.display === 'none') return;
      if (settingsEl.contains(e.target)) return;
      if (indicatorEl && indicatorEl.contains(e.target)) return;
      toggleSettings(false);
    };
    window.addEventListener('pointerdown', HANDLERS.onSettingsOutsidePointerDown, true);
  }

  function toggleSettings(open) {
    ensureSettingsPanel();
    settingsEl.style.display = open ? 'block' : 'none';
  }

  /* ===================== AUDIO ===================== */

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

  function volGainValue() {
    const v = clampNum(Number(SETTINGS.volume), 0, 100) / 100;
    return 0.35 * v;
  }

  function scheduleTones(ctx, gain, seq) {
    for (const s of seq) {
      const o = ctx.createOscillator();
      o.type = s.type || 'triangle';
      o.frequency.value = s.f;
      o.connect(gain);

      const startAt = ctx.currentTime + (s.t / 1000);
      const stopAt = startAt + (s.d / 1000);
      try { o.start(startAt); o.stop(stopAt); } catch (_) {}
    }
  }

  function getPresetSeq(name) {
    switch (name) {
      case 'short':
        return [
          { f: 900, d: 120, t: 0, type: 'triangle' },
          { f: 650, d: 140, t: 160, type: 'triangle' },
        ];
      case 'double':
        return [
          { f: 880, d: 120, t: 0, type: 'square' },
          { f: 880, d: 120, t: 180, type: 'square' },
        ];
      case 'siren':
        return [
          { f: 520, d: 160, t: 0, type: 'sine' },
          { f: 720, d: 160, t: 170, type: 'sine' },
          { f: 520, d: 160, t: 340, type: 'sine' },
          { f: 720, d: 160, t: 510, type: 'sine' },
        ];
      case 'click':
        return [
          { f: 1200, d: 60, t: 0, type: 'square' },
          { f: 900, d: 60, t: 90, type: 'square' },
          { f: 1200, d: 60, t: 180, type: 'square' },
        ];
      case 'classic':
      default:
        return [
          { f: 700, d: 150, t: 0, type: 'triangle' },
          { f: 500, d: 180, t: 180, type: 'triangle' },
          { f: 700, d: 150, t: 400, type: 'triangle' },
          { f: 500, d: 180, t: 580, type: 'triangle' },
        ];
    }
  }

  function playBeep(forcePreview = false) {
    if (!SETTINGS.soundEnabled && !forcePreview) return;

    const t = now();
    if (!forcePreview && (t - lastBeepAt < MIN_BEEP_GAP_MS)) return;
    lastBeepAt = t;

    const ctx = ensureAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') return;

    try {
      const gain = ctx.createGain();
      gain.gain.value = volGainValue();
      gain.connect(ctx.destination);

      const seq = getPresetSeq(SETTINGS.soundPreset);
      scheduleTones(ctx, gain, seq);
    } catch (_) {}
  }

  function setupAudioUnlockHooks() {
    const once = async () => {
      await unlockAudioIfNeeded();

      if (pendingBeepAt && audioUnlocked) {
        const age = now() - pendingBeepAt;
        if (age <= PENDING_BEEP_TTL_MS && hasActiveErrorNow && pendingBeepSig === lastErrorSignature) {
          playBeep(false);
        }
        pendingBeepAt = 0;
        pendingBeepSig = '';
      }

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
    try {
      if (ctx.state !== 'closed') await ctx.close();
    } catch (_) {}
  }

  /* ===================== SAP/UI5 HELPERS ===================== */

  function safeGetCore() {
    try { return window.sap?.ui?.getCore?.(); } catch (_) { return null; }
  }

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

  function matchesErrorText(text) {
    const t = norm(text);
    if (!t) return false;
    for (const re of ERROR_PATTERNS) {
      if (re.test(t)) return true;
    }
    return false;
  }

  function ui5GetErrorState() {
    const msgs = getUi5MessagesData();
    if (!msgs) return { active: false, signature: '' };

    const hits = [];
    for (const m of msgs) {
      const msgText = norm(m?.message || m?.text || '');
      const descText = norm(m?.description || '');
      const combo = (msgText + ' ' + descText).trim();
      if (!combo) continue;

      if (matchesErrorText(combo)) {
        const key = norm(m?.id || m?.code || '') || combo;
        hits.push(key);
      }
    }
    hits.sort();
    return { active: hits.length > 0, signature: hits.join('||') };
  }

  /* ===================== SCREEN STATE ===================== */

  function getBaseScreenState() {
    const page = findFirst(SELECTORS.pageHuControl);
    const title = findFirst(SELECTORS.titleHuControl);
    if (!page || !title) return 'WHITE';

    const titleInner = findFirst(SELECTORS.titleHuControlInner);
    const t = norm(titleInner?.textContent || title?.textContent || '');

    const re = /:\s*\d+\s*\(\s*\d+\s*\)/;
    if (re.test(t)) return 'GREEN';
    return 'YELLOW';
  }

  function getHuIdFromTitle() {
    const titleInner = findFirst(SELECTORS.titleHuControlInner) || findFirst(SELECTORS.titleHuControl);
    const t = norm(titleInner?.textContent || '');
    if (!t) return '';

    const m = t.match(/:\s*(\d{6,})\s*\(\s*(\d{10,})\s*\)/);
    if (m) return `${m[1]}(${m[2]})`;

    const m2 = t.match(/\b(\d{6,})\b/);
    return m2 ? m2[1] : '';
  }

  function setIndicatorState(baseState, hasErrorOverlay) {
    ensureIndicator();

    if (baseState === 'WHITE') {
      indicatorEl.textContent = '⚪';
      indicatorEl.style.cursor = 'default';
      stopPulseSync();
      return;
    }
    if (baseState === 'YELLOW') {
      indicatorEl.textContent = '🟡';
      indicatorEl.style.cursor = 'default';
      stopPulseSync();
      return;
    }

    indicatorEl.textContent = hasErrorOverlay ? '🔴' : '🟢';
    indicatorEl.style.cursor = hasErrorOverlay ? 'pointer' : 'default';
  }

  /* ===================== WEITERE ===================== */

  function parseTriggerXY() {
    const infoEl = findFirst(SELECTORS.weitereTriggerInfo);
    if (!infoEl) return null;

    const txt = norm(infoEl.textContent || '');
    const m = txt.match(/\[\s*(\d+)\s*\/\s*(\d+)\s*\]/);
    if (!m) return null;

    const x = Number(m[1]);
    const y = Number(m[2]);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < 0 || y <= 0) return null;
    if (x > Number.MAX_SAFE_INTEGER || y > Number.MAX_SAFE_INTEGER) return null;

    return { x, y };
  }

  function isWeitereNeeded(baseState) {
    if (baseState !== 'GREEN') return false;

    const hasContainer = !!findFirst(SELECTORS.weitereTriggerList);
    const hasTrigger = !!findFirst(SELECTORS.weitereTrigger);
    const hasText = !!findFirst(SELECTORS.weitereTriggerText);
    const hasInfo = !!findFirst(SELECTORS.weitereTriggerInfo);
    if (!hasContainer || !hasTrigger || !hasText || !hasInfo) return false;

    const xy = parseTriggerXY();
    if (!xy) return false;

    return xy.x < xy.y;
  }

  function getHuTableIdFromTriggerText() {
    const t = findFirst(SELECTORS.weitereTriggerText);
    if (!t?.id) return null;
    return t.id.replace(/--tableHuItems-triggerText$/, '--tableHuItems');
  }

  function getHuTableControl() {
    const core = safeGetCore();
    if (!core) return null;

    const id = getHuTableIdFromTriggerText();
    if (id) {
      const c = core.byId?.(id);
      if (c) return c;
    }

    const any = findFirst(SELECTORS.tableHuItemsLoose);
    if (any?.id) {
      const c2 = core.byId?.(any.id);
      if (c2) return c2;
    }
    return null;
  }

  function ui5LoadMore(tableCtrl) {
    if (!tableCtrl) return false;

    try {
      if (typeof tableCtrl.triggerGrowing === 'function') { tableCtrl.triggerGrowing(); return true; }
      if (typeof tableCtrl._triggerGrowing === 'function') { tableCtrl._triggerGrowing(); return true; }
      const gd = tableCtrl._oGrowingDelegate;
      if (gd && typeof gd.requestNewPage === 'function') { gd.requestNewPage(); return true; }
    } catch (_) {}
    return false;
  }

  function stopRamp() {
    if (rampTimer) { clearTimeout(rampTimer); rampTimer = null; }
    rampActive = false;
    weitereRunning = false;
    rampActiveUntil = 0;
    rampTries = 0;
    rampNoGrowStreak = 0;
    lastRowCountSeen = 0;
  }

  function scheduleRampTick(delayMs) {
    if (rampTimer) return;
    rampTimer = setTimeout(() => {
      rampTimer = null;

      if (!rampActive) { stopRamp(); return; }
      if (now() > rampActiveUntil) { stopRamp(); return; }
      if (rampTries >= RAMP_MAX_TRIES) { stopRamp(); return; }
      if (isUserBusy()) { stopRamp(); return; }

      rampTries++;

      const tableCtrl = getHuTableControl();
      if (!tableCtrl) { stopRamp(); return; }

      const ok = ui5LoadMore(tableCtrl);
      if (ok) burstsDone++;

      const rc = qAll(SELECTORS.tableRows[0]).length;
      if (rc > lastRowCountSeen) {
        lastRowCountSeen = rc;
        rampNoGrowStreak = 0;
      } else {
        rampNoGrowStreak++;
        if (rampNoGrowStreak >= RAMP_NO_GROW_STOP_AFTER) { stopRamp(); return; }
      }

      scheduleRampTick(RAMP_TRY_EVERY_MS);
    }, delayMs);
  }

  function startRampIfAllowed(baseState) {
    if (baseState !== 'GREEN') return;
    if (!isWeitereNeeded(baseState)) return;
    if (isUserBusy()) return;
    if (burstsDone >= MAX_BURSTS_PER_SESSION) return;

    const t = now();
    if (rampActive) return;
    if (weitereRunning) return;
    if (t - lastWeitereAt < RAMP_MIN_GAP_MS) return;

    const tableCtrl = getHuTableControl();
    if (!tableCtrl) return;

    rampActive = true;
    weitereRunning = true;
    lastWeitereAt = t;

    rampActiveUntil = t + RAMP_WINDOW_MS;
    rampTries = 0;
    rampNoGrowStreak = 0;
    lastRowCountSeen = qAll(SELECTORS.tableRows[0]).length;

    setTimeout(() => { weitereRunning = false; }, 250);
    scheduleRampTick(0);
  }

  /* ===================== NUMBER PARSING ===================== */

  function parseLocaleNumber(text) {
    if (text == null) return null;

    let s = String(text).replace(/\u00A0/g, ' ').trim();
    if (!s) return null;

    s = s.replace(/[^\d,\.\-\+\s']/g, '').trim();
    if (!s) return null;

    s = s.replace(/[\s']/g, '');

    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');

    let decSep = '';
    if (lastComma !== -1 && lastDot !== -1) decSep = (lastComma > lastDot) ? ',' : '.';
    else if (lastComma !== -1) decSep = ',';
    else if (lastDot !== -1) decSep = '.';

    if (decSep) {
      const thouSep = (decSep === ',') ? '.' : ',';
      s = s.replace(new RegExp('\\' + thouSep, 'g'), '');
      if (decSep === ',') s = s.replace(/,/g, '.');
    } else {
      s = s.replace(/[.,]/g, '');
    }

    s = s.replace(/^\+/, '');

    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
  }

  /* ===================== HIGHLIGHT HELPERS ===================== */

  function applyErrorMarkToRow(tr, on) {
    if (!tr) return;

    if (!on) {
      tr.classList.remove('kc-error-highlight');
      tr.classList.remove('kc-anim');
      return;
    }

    if (SETTINGS.highlightEnabled) tr.classList.add('kc-error-highlight');
    else tr.classList.remove('kc-error-highlight');

    if (SETTINGS.highlightAnimate) tr.classList.add('kc-anim');
    else tr.classList.remove('kc-anim');
  }

  function refreshHighlightAnimationClass() {
    const rows = qAll(SELECTORS.tableRows[0]);
    rows.forEach(tr => {
      const isMarked = tr.classList.contains('kc-error-highlight') || tr.classList.contains('kc-anim');
      if (!isMarked) return;

      if (SETTINGS.highlightEnabled) tr.classList.add('kc-error-highlight');
      else tr.classList.remove('kc-error-highlight');

      if (SETTINGS.highlightAnimate) tr.classList.add('kc-anim');
      else tr.classList.remove('kc-anim');
    });
  }

  function clearAllHighlights() {
    qAll('tr.sapMListTblRow.kc-error-highlight, tr.sapMListTblRow.kc-anim')
      .forEach(tr => applyErrorMarkToRow(tr, false));
  }

  /* ===================== TABLE SCAN ===================== */

  function rebuildScanCacheIfNeeded() {
    const t = now();
    if (!tableDirty && scanCache.rows.length && (t - scanCache.builtAt < 1000)) return;

    scanCache.rows = qAll(SELECTORS.tableRows[0]);
    scanCache.toCountNodesByRow = new Map();

    for (const tr of scanCache.rows) {
      const nodes = tr.querySelectorAll(SELECTORS.toCountTextInRow[0]);
      scanCache.toCountNodesByRow.set(tr, Array.from(nodes));
    }
    scanCache.builtAt = t;
  }

  function scanErrorsUnified(baseState, ui5State) {
    const t = now();
    if (t - lastFullScanAt < FULL_SCAN_MIN_GAP_MS) {
      return {
        toCountValid: false,
        toCountNegCount: 0,
        domTextCount: 0,
        markedCount: 0,
        negRowKeys: [],
        domRowKeys: [],
        foundContainers: 0,
        parsedAny: 0
      };
    }
    lastFullScanAt = t;

    rebuildScanCacheIfNeeded();

    let foundContainers = 0;
    let parsedAny = 0;
    let toCountNegCount = 0;
    let domTextCount = 0;

    const negRowKeys = [];
    const domRowKeys = [];

    const ui5Active = !!ui5State?.active;

    for (let i = 0; i < scanCache.rows.length; i++) {
      const tr = scanCache.rows[i];
      const nodes = scanCache.toCountNodesByRow.get(tr) || [];
      if (nodes.length) foundContainers++;

      // ✅ 1) ToCount анализ на уровне строки
      let rowHasNeg = false;
      let rowToCountParsed = false;

      for (const node of nodes) {
        const n = parseLocaleNumber(node.textContent || '');
        if (n !== null) {
          rowToCountParsed = true;
          parsedAny++;
          if (n < 0) rowHasNeg = true;
        }
      }

      // ✅ 2) FALLBACK ТОЛЬКО для строки: если ToCount в этой строке не распарсился — читаем ТОЛЬКО статус
      let rowHasDomErr = false;
      if (!rowToCountParsed || ui5Active) {
        const statusEl = tr.querySelector(SELECTORS.statusTextInRow[0]);
        const statusText = norm(statusEl?.textContent || '');
        if (matchesErrorText(statusText)) rowHasDomErr = true;
      }

      if (rowHasNeg) { toCountNegCount++; negRowKeys.push(`${i}`); }
      if (rowHasDomErr) { domTextCount++; domRowKeys.push(`${i}`); }

      const mark = rowHasNeg || rowHasDomErr;
      applyErrorMarkToRow(tr, mark);
    }

    const toCountValid = (foundContainers > 0 && parsedAny > 0);
    const markedCount = qAll('tr.sapMListTblRow.kc-error-highlight, tr.sapMListTblRow.kc-anim').length;

    return {
      toCountValid,
      toCountNegCount,
      domTextCount,
      markedCount,
      negRowKeys,
      domRowKeys,
      foundContainers,
      parsedAny
    };
  }

  /* ===================== ERROR SIGNATURE ===================== */

  function buildErrorSignature(kind, baseState, activeCount, extraKey) {
    const hu = getHuIdFromTitle();
    const stabil = norm(extraKey || '');
    return `${kind}::${baseState}::${hu}::${activeCount}::${stabil}`;
  }

  function setPendingBeepIfNew(sig) {
    if (!sig) return;

    if (sig !== lastErrorSignature) {
      lastErrorSignature = sig;
      lastErrorAt = now();

      pendingBeepAt = now();
      pendingBeepSig = sig;

      toastDismissed = false;
    }
  }

  function maybePlayPendingBeep() {
    if (!pendingBeepAt) return;

    const age = now() - pendingBeepAt;
    if (age > PENDING_BEEP_TTL_MS) { pendingBeepAt = 0; pendingBeepSig = ''; return; }
    if (!hasActiveErrorNow) { pendingBeepAt = 0; pendingBeepSig = ''; return; }
    if (pendingBeepSig !== lastErrorSignature) { pendingBeepAt = 0; pendingBeepSig = ''; return; }

    playBeep(false);

    if (audioUnlocked) {
      pendingBeepAt = 0;
      pendingBeepSig = '';
    }
  }

  /* ===================== OBSERVER ===================== */

  function isInsideOurUi(node) {
    if (!node || !(node instanceof Node)) return false;
    for (const s of SELECTORS.ourUiRoots) {
      const root = q1(s);
      if (root && root.contains(node)) return true;
    }
    return false;
  }

  function getHuTableRootForObserver() {
    return findFirst(SELECTORS.tableHuItemsExact) || findFirst(SELECTORS.tableHuItemsLoose);
  }

  function detachObserver() {
    try { obs?.disconnect?.(); } catch (_) {}
    obs = null;
    obsTarget = null;
  }

  function setupObserverForTable() {
    const target = getHuTableRootForObserver();
    if (!target) { detachObserver(); return; }
    if (obs && obsTarget === target) return;

    detachObserver();

    let lastObsAt = 0;

    obs = new MutationObserver((mutations) => {
      const t = now();
      if (t - lastObsAt < OBS_THROTTLE_MS) return;

      for (const m of mutations) {
        const src = m.target;
        if (isInsideOurUi(src)) continue;

        let skip = false;
        if (m.addedNodes && m.addedNodes.length) {
          for (const n of m.addedNodes) {
            if (isInsideOurUi(n)) { skip = true; break; }
          }
        }
        if (skip) continue;

        lastObsAt = t;
        tableDirty = true;
        scanCache.builtAt = 0;
        return;
      }
    });

    obs.observe(target, { childList: true, subtree: true });
    obsTarget = target;
  }

  /* ===================== TICK ===================== */

  function scheduleTick(ms) {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, ms);
  }

  function lightCleanupOnLeaveHu(baseState) {
    stopRamp();
    detachObserver();
    stopPulseSync();

    hasActiveErrorNow = false;
    setIndicatorState(baseState, false);

    hideToast();
    clearAllHighlights();

    pendingBeepAt = 0;
    pendingBeepSig = '';
    toastDismissed = false;
  }

  function tick() {
    if (destroyed) return;

    injectStyle();
    applyColorProfile();
    ensureIndicator();

    const baseState = getBaseScreenState();

    if (baseState === 'GREEN') setupObserverForTable();
    else detachObserver();

    if (baseState === 'WHITE') {
      lightCleanupOnLeaveHu('WHITE');
      scheduleTick(SLOW_TICK_MS);
      return;
    }

    if (baseState === 'YELLOW') {
      lightCleanupOnLeaveHu('YELLOW');
      scheduleTick(SLOW_TICK_MS);
      return;
    }

    // GREEN
    const ui5 = ui5GetErrorState();
    const sc = scanErrorsUnified(baseState, ui5);

    let hasError = false;
    let activeCount = 0;
    let sourceLabel = '';
    let errKind = '';

    if (sc.toCountValid && sc.toCountNegCount > 0) {
      hasError = true;
      activeCount = sc.toCountNegCount;
      sourceLabel = 'Zum Nachzählen';
      errKind = 'TOCOUNT_NEG';
    } else if (ui5.active) {
      hasError = true;
      activeCount = Math.max(sc.domTextCount, 1);
      sourceLabel = 'UI5';
      errKind = 'UI5_MSG';
    } else if (sc.domTextCount > 0) {
      hasError = true;
      activeCount = sc.domTextCount;
      sourceLabel = 'Status';
      errKind = 'ROW_STATUS';
    } else {
      hasError = false;
      activeCount = 0;
      sourceLabel = '';
      errKind = '';
    }

    hasActiveErrorNow = hasError;
    setIndicatorState('GREEN', hasError);

    if (hasError && SETTINGS.highlightAnimate) startPulseSync();
    else stopPulseSync();

    if (hasError) {
      const extraKey =
        (errKind === 'TOCOUNT_NEG') ? sc.negRowKeys.join(',') :
        (errKind === 'UI5_MSG') ? ui5.signature :
        sc.domRowKeys.join(',');

      const sig = buildErrorSignature(errKind, baseState, activeCount, extraKey);
      setPendingBeepIfNew(sig);

      if (!toastDismissed) showToast(activeCount, sourceLabel);

      unlockAudioIfNeeded();
      maybePlayPendingBeep();
    } else {
      hideToast();
      clearAllHighlights();
      toastDismissed = false;
      pendingBeepAt = 0;
      pendingBeepSig = '';
    }

    startRampIfAllowed(baseState);

    const wantFast = hasError || tableDirty;
    tableDirty = false;
    scheduleTick(wantFast ? FAST_TICK_MS : SLOW_TICK_MS);
  }

  /* ===================== TEARDOWN (P0) ===================== */

  function removeUiElements() {
    try {
      const ids = ['kcStopToast', 'kcSettings', 'kcUiLayer', 'kcStyle'];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
    } catch (_) {}
    toastEl = null;
    settingsEl = null;
    indicatorEl = null;
  }

  function removeGlobalListeners() {
    try {
      if (HANDLERS.onUserBusy) {
        window.removeEventListener('keydown', HANDLERS.onUserBusy, true);
        window.removeEventListener('mousedown', HANDLERS.onUserBusy, true);
        window.removeEventListener('touchstart', HANDLERS.onUserBusy, true);
        window.removeEventListener('wheel', HANDLERS.onUserBusy, true);
      }
      if (HANDLERS.onSettingsOutsidePointerDown) {
        window.removeEventListener('pointerdown', HANDLERS.onSettingsOutsidePointerDown, true);
      }
      if (HANDLERS.onBeforeUnload) {
        window.removeEventListener('beforeunload', HANDLERS.onBeforeUnload, true);
      }
      if (HANDLERS.onPageHide) {
        window.removeEventListener('pagehide', HANDLERS.onPageHide, true);
      }
    } catch (_) {}
    HANDLERS.onUserBusy = null;
    HANDLERS.onSettingsOutsidePointerDown = null;
    HANDLERS.onBeforeUnload = null;
    HANDLERS.onPageHide = null;
  }

  function teardown(reason = 'teardown') {
    if (destroyed) return;
    destroyed = true;

    try { if (tickTimer) clearTimeout(tickTimer); } catch (_) {}
    tickTimer = null;

    stopRamp();
    detachObserver();
    stopPulseSync();

    pendingBeepAt = 0;
    pendingBeepSig = '';
    toastDismissed = false;
    hasActiveErrorNow = false;

    hideToast();
    clearAllHighlights();

    removeGlobalListeners();
    removeUiElements();

    closeAudioCtx();

    try {
      scanCache.rows = [];
      scanCache.toCountNodesByRow = new Map();
      scanCache.builtAt = 0;
    } catch (_) {}

    try { window[GUARD_KEY] = null; } catch (_) {}
  }

  try { window[GUARD_KEY] = { teardown }; } catch (_) {}

  /* ===================== INIT ===================== */

  function init() {
    applyColorProfile();
    injectStyle();
    ensureIndicator();
    ensureSettingsPanel();
    setupAudioUnlockHooks();

    HANDLERS.onUserBusy = () => bumpUserBusy();
    window.addEventListener('keydown', HANDLERS.onUserBusy, true);
    window.addEventListener('mousedown', HANDLERS.onUserBusy, true);
    window.addEventListener('touchstart', HANDLERS.onUserBusy, true);
    window.addEventListener('wheel', HANDLERS.onUserBusy, true);

    HANDLERS.onBeforeUnload = () => teardown('beforeunload');
    HANDLERS.onPageHide = () => teardown('pagehide');
    window.addEventListener('beforeunload', HANDLERS.onBeforeUnload, true);
    window.addEventListener('pagehide', HANDLERS.onPageHide, true);

    scheduleTick(300);
  }

  init();

})();