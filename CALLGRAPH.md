# CALLGRAPH — SAP Kontrollscan V8.8.4

## 1) Функции и вызовы (буллет-дерево)

- IIFE (main)
  - Guard pre-init
    - `window[GUARD_KEY].teardown('reinit')` (если уже был экземпляр)
  - `init()`
    - `applyColorProfile()`
    - `injectStyle()`
    - `ensureIndicator()`
      - `ensureUiLayer()`
      - listeners: click/contextmenu
    - `ensureSettingsPanel()`
      - `saveSettings()`
      - `applyColorProfile()`
      - `clearAllHighlights()`
      - `stopPulseSync()`
      - `refreshHighlightAnimationClass()`
      - `unlockAudioIfNeeded()`
      - `toggleSettings(false)`
      - `playBeep(true)`
      - listener `pointerdown(capture)` outside-close
    - `setupAudioUnlockHooks()`
      - `unlockAudioIfNeeded()`
      - `playBeep(false)` (при pending + unlocked)
      - remove temporary unlock listeners
    - window listeners (busy): `keydown/mousedown/touchstart/wheel -> bumpUserBusy()`
    - lifecycle listeners:
      - `beforeunload -> teardown('beforeunload')`
      - `pagehide -> teardown('pagehide')`
    - `scheduleTick(300)`
      - `setTimeout(tick, ms)`

- `tick()`
  - `injectStyle()`
  - `applyColorProfile()`
  - `ensureIndicator()`
  - `getBaseScreenState()`
    - `findFirst()`/`q1()`
  - observer branch
    - GREEN: `setupObserverForTable()`
      - `getHuTableRootForObserver()` -> `findFirst()`
      - `detachObserver()`
      - create `MutationObserver(callback)`
    - else: `detachObserver()`
  - WHITE/YELLOW
    - `lightCleanupOnLeaveHu(baseState)`
      - `stopRamp()`
      - `detachObserver()`
      - `stopPulseSync()`
      - `setIndicatorState(baseState,false)`
      - `hideToast()`
      - `clearAllHighlights()`
    - `scheduleTick(SLOW_TICK_MS)`
  - GREEN flow
    - `ui5GetErrorState()`
      - `getUi5MessagesData()` -> `safeGetCore()`
      - `matchesErrorText()`
    - `scanErrorsUnified(baseState, ui5)`
      - throttle guard by `FULL_SCAN_MIN_GAP_MS`
      - `rebuildScanCacheIfNeeded()`
        - `qAll(tableRows)`
      - per row:
        - `parseLocaleNumber()`
        - `matchesErrorText()`
        - `stableRowKey()`
        - `applyErrorMarkToRow()`
      - `qAll(marked rows)`
    - compute cascade (`TOCOUNT_NEG` / `UI5_MSG` / `ROW_STATUS`)
    - `setIndicatorState('GREEN', hasError)`
      - `ensureIndicator()`
      - `stopPulseSync()` (WHITE/YELLOW only)
    - pulse branch
      - error + animate: `startPulseSync()`
      - else: `stopPulseSync()`
    - error branch
      - `buildErrorSignature()`
        - `getHuIdFromTitle()` -> `findFirst()`
      - `setPendingBeepOnSignatureChange(sig, allowBeep)`
      - `showToast(activeCount, sourceLabel)` -> `ensureToast()`
      - `unlockAudioIfNeeded()`
      - `maybePlayPendingBeep()` -> `playBeep(false)`
    - no-error branch
      - `hideToast()`
      - `clearAllHighlights()`
    - `startRampIfAllowed(baseState)`
      - `isWeitereNeeded(baseState)` -> `parseTriggerXY()`
      - `isUserBusy()`
      - `getHuTableControl()`
        - `safeGetCore()`
        - `getHuTableIdFromTriggerText()`
      - schedule immediate `scheduleRampTick(0)`
        - inside callback:
          - guard checks (`rampActive`, TTL window, tries, userBusy)
          - `getHuTableControl()`
          - `ui5LoadMore(tableCtrl)`
          - `qAll(tableRows)` count/no-grow logic
          - recursive `scheduleRampTick(RAMP_TRY_EVERY_MS)` or `stopRamp()`
    - end tick
      - choose FAST/SLOW by `hasError || tableDirty`
      - `scheduleTick(...)`

- Teardown
  - `teardown(reason)`
    - clear `tickTimer`
    - `stopRamp()`
    - `detachObserver()`
    - `stopPulseSync()`
    - `hideToast()`
    - `clearAllHighlights()`
    - `removeGlobalListeners()`
    - `removeUiElements()`
    - `closeAudioCtx()`
    - reset caches/states
    - `window[GUARD_KEY] = null`

## 2) Таймеры / observer / listeners → ветки

### Таймеры
- `tickTimer` (`scheduleTick`) → `tick` main loop (FAST/SLOW режим).
- `pulseTimer` (`startPulseSync` via `setInterval`) → toggles `kc-pulse-on` class.
- `rampTimer` (`scheduleRampTick`) → повторные попытки `ui5LoadMore`.
- ad-hoc timeout в `startRampIfAllowed`: `setTimeout(() => weitereRunning=false, 250)`.

### MutationObserver
- `obs` в `setupObserverForTable` (target: table root, `childList+subtree`).
- callback:
  - игнорирует мутации внутри собственного UI (`isInsideOurUi`).
  - по валидной мутации: `tableDirty=true`, `scanCache.builtAt=0`.

### Глобальные listeners
- Busy tracking (в `init`):
  - `keydown/mousedown/touchstart/wheel` (capture) → `bumpUserBusy()`.
- Settings outside-click:
  - `pointerdown` (capture) → `toggleSettings(false)` при клике вне панели.
- Lifecycle:
  - `beforeunload/pagehide` (capture) → `teardown(...)`.
- Audio unlock temporary:
  - `pointerdown/keydown/touchstart` (capture) → `unlockAudioIfNeeded()` + optional pending beep.

## 3) Примечание по полноте

Список охватывает все именованные функции в файле и все явные callback-точки (timers/observer/listeners), влияющие на состояние, сканирование, сигналы и teardown.

