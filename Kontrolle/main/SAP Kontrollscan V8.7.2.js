// ==UserScript==
// @name         SAP Kontrollscan V8.7.2
// @namespace    local.sap.kontrollscan.stop
// @version      8.7.2
// @description  Settings: highlight/animation/sound/volume/signal + play + color profiles + synchronized pulse for multiple rows.
// @match        https://vhfiwp61ci.sap.ugfischer.com:44300/*
// @match        http://localhost:8000/kontrollscan.html
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== CONFIG ===================== */

  const ERROR_RE = /mengendifferenz vorhanden/i;

  // Частота основного цикла сканирования (когда есть ошибка или изменения в таблице)
  const FAST_TICK_MS = 350; // быстрый режим (каждые 250 мс)

  // Частота сканирования, когда всё спокойно (нет ошибок)
  const SLOW_TICK_MS = 850; // медленный режим (каждые 650 мс)


  // Минимальная пауза между звуковыми сигналами (анти-спам)
  const MIN_BEEP_GAP_MS = 800; // не чаще чем раз в 700 мс


  // Ограничение частоты реакции MutationObserver
  // (чтобы не запускать тяжёлые проверки слишком часто)
  const OBS_THROTTLE_MS = 250; // минимум 250 мс между реакциями


  // Время, в течение которого пользователь считается "активным"
  // (скроллит, кликает — в это время не трогаем "Weitere")
  const USER_BUSY_MS = 900; // 900 мс после действия пользователя


  // Максимальное время работы автодогрузки "Weitere"
  // после старта активного контроля
  const RAMP_WINDOW_MS = 4000; // до 9 "9000"секунд пытаемся раскрывать


  // Интервал между попытками догрузки списка
  const RAMP_TRY_EVERY_MS = 650; // каждые 650 мс новая попытка


  // Максимальное количество попыток раскрытия за одно окно
  const RAMP_MAX_TRIES = 6; // максимум 16 попыток


  // Минимальный интервал между двумя вызовами growing
  // (защита от слишком частых вызовов UI5)
  const RAMP_MIN_GAP_MS = 650; // минимум 450 мс между запросами


  // Общий лимит догрузок за одну сессию
  // (защита от бесконечной нагрузки)
  const MAX_BURSTS_PER_SESSION = 40;


  // Если несколько попыток подряд не увеличили количество строк —
  // считаем, что больше грузить нечего и останавливаемся
  const RAMP_NO_GROW_STOP_AFTER = 4; // 4 "пустые" попытки подряд → стоп

  const PULSE_MS = 850; // sync pulse tempo

  const COLOR_PROFILES = {
    classic: {
      fill: 'rgba(255, 0, 0, 0.08)',
      pulseOuter: 'rgba(255, 0, 0, 0.25)',
      pulseInner: 'rgba(255, 0, 0, 0.12)'
    },
    soft: {
      fill: 'rgba(255, 140, 0, 0.08)',
      pulseOuter: 'rgba(255, 140, 0, 0.25)',
      pulseInner: 'rgba(255, 140, 0, 0.12)'
    },
    neon: {
      fill: 'rgba(180, 0, 255, 0.10)',
      pulseOuter: 'rgba(180, 0, 255, 0.35)',
      pulseInner: 'rgba(180, 0, 255, 0.18)'
    },
    calm: {
      fill: 'rgba(0, 140, 255, 0.08)',
      pulseOuter: 'rgba(0, 140, 255, 0.25)',
      pulseInner: 'rgba(0, 140, 255, 0.12)'
    }
  };

  /* ===================== SETTINGS ===================== */

  const SETTINGS_KEY = 'kc_settings_v1';

  const DEFAULT_SETTINGS = {
    highlightEnabled: true,
    highlightAnimate: true,
    soundEnabled: true,
    volume: 22,
    soundPreset: 'classic', // classic|short|double|siren|click
    colorProfile: 'classic' // classic|soft|neon|calm
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

  let userBusyUntil = 0;

  // sync pulse
  let pulseOn = false;
  let pulseTimer = null;

  // ramp
  let rampActiveUntil = 0;
  let rampTries = 0;
  let rampTimer = null;
  let lastWeitereAt = 0;
  let burstsDone = 0;
  let weitereRunning = false;
  let rampNoGrowStreak = 0;
  let lastRowCountSeen = 0;

  // UI
  let toastEl = null;
  let indicatorEl = null;
  let settingsEl = null;

  // beep
  let lastBeepAt = 0;
  let audioCtx = null;
  let audioUnlocked = false;
  let pendingBeep = false;

  // scanning
  let tableDirty = true;
  let tickTimer = null;
  let obs = null;
  let lastSignature = '';
  let lastErrorCount = 0;
  let toastDismissed = false;

  // current truth for click behavior
  let hasActiveErrorNow = false;

  /* ===================== HELPERS ===================== */

  const now = () => Date.now();

  function bumpUserBusy() { userBusyUntil = now() + USER_BUSY_MS; }
  function isUserBusy() { return now() < userBusyUntil; }

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function safeGetCore() {
    try { return window.sap?.ui?.getCore?.(); } catch (_) { return null; }
  }

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
      .kc-error-highlight{
        background: var(--kc-fill-color) !important;
      }

      /* sync pulse: no keyframes */
      .kc-anim{
      /*220ms = скорость “подъёма/спада” (чем больше — тем плавнее, но медленнее)*/
      /*ease = кривая плавности (можно linear, ease-in-out, но ease обычно ок)*/
        transition: box-shadow 650ms ease;
        box-shadow: inset 0 0 0 0 var(--kc-pulse-outer);
      }
      /* when <html> has kc-pulse-on -> all animated rows pulse in sync */
      .kc-pulse-on .kc-anim{
        box-shadow: inset 0 0 0 6px var(--kc-pulse-inner);
      }

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
      #kcSettings .h{
        display:flex;
        align-items:center;
        justify-content:space-between;
        margin-bottom: 8px;
      }
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

      #kcSettings .row{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        margin: 6px 0;
      }
      #kcSettings label{cursor:pointer; user-select:none;}
      #kcSettings input[type="checkbox"]{ transform: translateY(1px); }

      #kcSettings select, #kcSettings input[type="range"]{
        width: 160px;
      }
      #kcSettings .small{
        opacity: .78;
        font-size: 12px;
        margin-top: 8px;
      }
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

      <div class="small">Rechtsklick auf ⚪/🟡/🟢/🔴 öffnet dieses меню.</div>
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
      // if animation OFF -> stop sync pulse immediately
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

    window.addEventListener('pointerdown', (e) => {
      if (!settingsEl || settingsEl.style.display === 'none') return;
      if (settingsEl.contains(e.target)) return;
      if (indicatorEl && indicatorEl.contains(e.target)) return;
      toggleSettings(false);
    }, true);
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
      if (pendingBeep && audioUnlocked) {
        playBeep();
        pendingBeep = false;
      }
      window.removeEventListener('pointerdown', once, true);
      window.removeEventListener('keydown', once, true);
      window.removeEventListener('touchstart', once, true);
    };
    window.addEventListener('pointerdown', once, true);
    window.addEventListener('keydown', once, true);
    window.addEventListener('touchstart', once, true);
  }

  /* ===================== SCREEN STATE ===================== */

  function getBaseScreenState() {
    const page = document.querySelector('[id$="--pageHuControl"]');
    const title = document.querySelector('[id$="--titleTableHuControl"]');
    if (!page || !title) return 'WHITE';

    const titleInner = document.querySelector('[id$="--titleTableHuControl-inner"]');
    const t = norm(titleInner?.textContent || title?.textContent || '');

    const re = /:\s*\d+\s*\(\s*\d+\s*\)/;
    if (re.test(t)) return 'GREEN';
    return 'YELLOW';
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
    const infoEl = document.querySelector('[id$="--tableHuItems-triggerInfo"]');
    if (!infoEl) return null;

    const txt = norm(infoEl.textContent || '');
    const m = txt.match(/\[\s*(\d+)\s*\/\s*(\d+)\s*\]/);
    if (!m) return null;

    const x = Number(m[1]);
    const y = Number(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    return { x, y };
  }

  function isWeitereNeeded() {
    const hasContainer = !!document.querySelector('[id$="--tableHuItems-triggerList"]');
    const hasTrigger = !!document.querySelector('[id$="--tableHuItems-trigger"]');
    const hasText = !!document.querySelector('[id$="--tableHuItems-triggerText"]');
    const hasInfo = !!document.querySelector('[id$="--tableHuItems-triggerInfo"]');
    if (!hasContainer || !hasTrigger || !hasText || !hasInfo) return false;

    const xy = parseTriggerXY();
    if (!xy) return false;

    return xy.x < xy.y;
  }

  function getHuTableIdFromTriggerText() {
    const t = document.querySelector('[id$="--tableHuItems-triggerText"]');
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

    const any = document.querySelector('[id*="--tableHuItems"]');
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
    if (rampTimer) clearInterval(rampTimer);
    rampTimer = null;
    weitereRunning = false;
    rampActiveUntil = 0;
    rampTries = 0;
    rampNoGrowStreak = 0;
  }

  function startRampIfAllowed(baseState) {
    if (baseState !== 'GREEN') return;
    if (!isWeitereNeeded()) return;
    if (isUserBusy()) return;
    if (burstsDone >= MAX_BURSTS_PER_SESSION) return;

    const t = now();
    if (weitereRunning) return;
    if (t - lastWeitereAt < RAMP_MIN_GAP_MS) return;

    const tableCtrl = getHuTableControl();
    if (!tableCtrl) return;

    weitereRunning = true;
    lastWeitereAt = t;
    rampActiveUntil = t + RAMP_WINDOW_MS;
    rampTries = 0;
    rampNoGrowStreak = 0;

    lastRowCountSeen = document.querySelectorAll('tr.sapMListTblRow').length;

    rampTimer = setInterval(() => {
      const tt = now();
      if (tt > rampActiveUntil) { stopRamp(); return; }
      if (rampTries >= RAMP_MAX_TRIES) { stopRamp(); return; }
      if (isUserBusy()) { stopRamp(); return; }
      if (!isWeitereNeeded()) { stopRamp(); return; }

      rampTries++;

      const ok = ui5LoadMore(tableCtrl);
      if (ok) burstsDone++;

      const rc = document.querySelectorAll('tr.sapMListTblRow').length;
      if (rc > lastRowCountSeen) {
        lastRowCountSeen = rc;
        rampNoGrowStreak = 0;
      } else {
        rampNoGrowStreak++;
        if (rampNoGrowStreak >= RAMP_NO_GROW_STOP_AFTER) {
          stopRamp();
          return;
        }
      }
    }, RAMP_TRY_EVERY_MS);
  }

  /* ===================== ERROR CASCADE ===================== */

  function parseSignedNumber(text) {
    const t = norm(text).replace(/\s/g, '').replace(',', '.');
    if (!t) return NaN;
    return Number(t);
  }

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
    const rows = document.querySelectorAll('tr.sapMListTblRow');
    rows.forEach(tr => {
      const isMarked = tr.classList.contains('kc-error-highlight') || tr.classList.contains('kc-anim');
      if (!isMarked) return;

      if (SETTINGS.highlightEnabled) tr.classList.add('kc-error-highlight');
      else tr.classList.remove('kc-error-highlight');

      if (SETTINGS.highlightAnimate) tr.classList.add('kc-anim');
      else tr.classList.remove('kc-anim');
    });
  }

  function scanToCountNegatives() {
    const rows = Array.from(document.querySelectorAll('tr.sapMListTblRow'));
    let foundContainers = 0;
    let parsedAny = 0;
    let negCount = 0;

    for (const tr of rows) {
      const nodes = tr.querySelectorAll('[id*="--objectNumberQuanToCount"] .sapMObjectNumberText');
      if (nodes.length) foundContainers++;

      let rowHasNeg = false;

      for (const node of nodes) {
        const n = parseSignedNumber(node.textContent || '');
        if (!Number.isNaN(n)) {
          parsedAny++;
          if (n < 0) rowHasNeg = true;
        }
      }

      applyErrorMarkToRow(tr, rowHasNeg);
      if (rowHasNeg) negCount++;
    }

    const valid = (foundContainers > 0 && parsedAny > 0);
    return { valid, negCount, foundContainers, parsedAny };
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

  function ui5HasMengendifferenz() {
    const msgs = getUi5MessagesData();
    if (!msgs) return { active: false, signature: '' };

    const hits = [];
    for (const m of msgs) {
      const msgText = norm(m?.message || m?.text || '');
      const descText = norm(m?.description || '');
      const combo = (msgText + ' ' + descText).trim();
      if (!combo) continue;

      if (ERROR_RE.test(combo)) {
        const key = norm(m?.id || m?.code || '') || combo;
        hits.push(key);
      }
    }
    hits.sort();
    return { active: hits.length > 0, signature: hits.join('||') };
  }

  function highlightByMengendifferenzText() {
    const rows = Array.from(document.querySelectorAll('tr.sapMListTblRow'));
    let count = 0;

    for (const tr of rows) {
      const rowText = norm(tr.textContent || '');
      const isError = ERROR_RE.test(rowText);
      applyErrorMarkToRow(tr, isError);
      if (isError) count++;
    }
    return count;
  }

  function clearAllHighlights() {
    document.querySelectorAll('tr.sapMListTblRow.kc-error-highlight, tr.sapMListTblRow.kc-anim')
      .forEach(tr => applyErrorMarkToRow(tr, false));
  }

  /* ===================== MAIN TICK ===================== */

  function computeSignature(channel, count, extra) {
    return `${channel}::${count}::${extra || ''}`;
  }

  function scheduleTick(ms) {
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = setTimeout(tick, ms);
  }

  function tick() {
    injectStyle();
    ensureIndicator();

    const baseState = getBaseScreenState();

    if (baseState === 'WHITE') {
      hasActiveErrorNow = false;
      setIndicatorState('WHITE', false);
      hideToast();
      clearAllHighlights();
      stopPulseSync();
      lastErrorCount = 0;
      pendingBeep = false;
      toastDismissed = false;
      lastSignature = '';
      scheduleTick(SLOW_TICK_MS);
      return;
    }

    if (baseState === 'YELLOW') {
      hasActiveErrorNow = false;
      setIndicatorState('YELLOW', false);
      hideToast();
      clearAllHighlights();
      stopPulseSync();
      lastErrorCount = 0;
      pendingBeep = false;
      toastDismissed = false;
      lastSignature = '';
      scheduleTick(SLOW_TICK_MS);
      return;
    }

    // GREEN
    const tc = scanToCountNegatives();

    let activeCount = 0;
    let hasError = false;
    let sourceLabel = '';

    if (tc.valid) {
      activeCount = tc.negCount;
      hasError = activeCount > 0;
      sourceLabel = 'Zum Nachzählen';
    } else {
      const ui5 = ui5HasMengendifferenz();
      const tableCount = highlightByMengendifferenzText();

      hasError = !!ui5.active || tableCount > 0;
      activeCount = hasError ? Math.max(tableCount, ui5.active ? 1 : 0) : 0;
      sourceLabel = 'UI5';
    }

    hasActiveErrorNow = hasError;
    setIndicatorState('GREEN', hasError);

    // ✅ sync pulse only when: error + animation enabled
    if (hasError && SETTINGS.highlightAnimate) startPulseSync();
    else stopPulseSync();

    if (hasError) {
      const isNewErrorEvent =
        (lastErrorCount === 0 && activeCount > 0) ||
        (activeCount > lastErrorCount);

      if (isNewErrorEvent) {
        toastDismissed = false;
        pendingBeep = true;
      }

      if (!toastDismissed) {
        showToast(activeCount, sourceLabel);
      }

      unlockAudioIfNeeded();

      if (pendingBeep) {
        playBeep(false);
        if (audioUnlocked) pendingBeep = false;
      }
    } else {
      hideToast();
      clearAllHighlights();
      pendingBeep = false;
      toastDismissed = false;
    }

    lastErrorCount = activeCount;

    startRampIfAllowed('GREEN');

    const sig = computeSignature(sourceLabel, activeCount, isWeitereNeeded() ? 'more' : 'nomore');
    const changed = sig !== lastSignature;
    lastSignature = sig;

    const wantFast = hasError || tableDirty || changed;
    tableDirty = false;

    scheduleTick(wantFast ? FAST_TICK_MS : SLOW_TICK_MS);
  }

  /* ===================== OBSERVER (light) ===================== */

  function setupObserver() {
    if (obs) return;

    let lastObsAt = 0;
    obs = new MutationObserver(() => {
      const t = now();
      if (t - lastObsAt < OBS_THROTTLE_MS) return;
      lastObsAt = t;
      tableDirty = true;
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ===================== INIT ===================== */

  function init() {
    applyColorProfile();
    injectStyle();
    ensureIndicator();
    setupObserver();
    setupAudioUnlockHooks();
    ensureSettingsPanel();

    window.addEventListener('keydown', bumpUserBusy, true);
    window.addEventListener('mousedown', bumpUserBusy, true);
    window.addEventListener('touchstart', bumpUserBusy, true);
    window.addEventListener('wheel', bumpUserBusy, true);

    scheduleTick(300);
  }

  init();

})();