"use strict";

const STATE_KEY = "huCounterState";
const {
  normalizeSettings,
  getDisplayShift,
  getShiftEvents,
  getExtraEvents,
  getShiftMetrics,
  hmToMin,
  dateToLocalMinutes
} = globalThis.HuCounterShiftMath;

document.addEventListener("DOMContentLoaded", () => {
  renderVersion();
  render();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STATE_KEY]) {
    renderState(changes[STATE_KEY].newValue);
  }
});

async function render() {
  const data = await chrome.storage.local.get(STATE_KEY);
  renderState(data[STATE_KEY]);
}

function renderVersion() {
  const manifest = chrome.runtime.getManifest();
  document.getElementById("extensionVersion").textContent = `v${manifest.version}`;
}

function renderState(state) {
  const safeState = normalizeState(state);
  const settings = normalizeSettings(safeState.settings);
  const now = new Date();
  const shift = getDisplayShift(settings.shifts, now, settings);

  document.getElementById("lastHu").textContent = safeState.lastHu || "-";
  document.getElementById("lastCompletedAt").textContent = safeState.lastCompletedAt
    ? new Date(safeState.lastCompletedAt).toLocaleString("de-DE")
    : "-";

  if (!shift) {
    renderOutsideShift(safeState);
    return;
  }

  const shiftEvents = getShiftEvents(safeState.events, shift, now);
  const extraEvents = getExtraEvents(safeState.events, settings.shifts, now, settings);
  const metrics = getShiftMetrics({
    shift,
    now,
    targetPerWorkHour: settings.targetPerWorkHour,
    events: shiftEvents
  });

  renderMetrics(shift, metrics, extraEvents.length);
  renderAchievementChart(document.getElementById("achievementChart"), {
    shift,
    now,
    metrics
  });
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    count: 0,
    processedHus: {},
    lastHu: null,
    lastCompletedAt: null,
    events: [],
    settings: undefined,
    ...state,
    events: Array.isArray(state.events) ? state.events : []
  };
}

function renderOutsideShift(state) {
  document.getElementById("shiftName").textContent = "Außerhalb der Schicht";
  document.getElementById("count").textContent = `${state.count || 0}`;
  document.getElementById("forecast").textContent = "Prognose -";
  document.getElementById("pace").textContent = "-";
  document.getElementById("extra").textContent = "-";
  setStatus("outside", "Pause");
  document.getElementById("achievementChart").innerHTML = `
    <svg class="achievementChart outside" viewBox="0 0 100 64" role="img" aria-label="Keine aktive Schicht">
      <rect x="0" y="22" width="100" height="20" rx="5" class="axis"></rect>
      <text x="50" y="35" text-anchor="middle" class="tick">Keine aktive Schicht</text>
    </svg>
  `;
}

function renderMetrics(shift, metrics, extraCount) {
  const goal = Math.round(metrics.shiftGoal);
  const forecast = Math.round(metrics.forecast);
  const pace = Math.round(metrics.pacePerWorkHour);

  document.getElementById("shiftName").textContent = `${shift.name} ${shift.start}-${shift.end}`;
  document.getElementById("count").textContent = `${metrics.actual} / ${goal}`;
  document.getElementById("forecast").textContent = `Prognose ${forecast} HU`;
  document.getElementById("pace").textContent = `${pace} HU/h`;
  document.getElementById("extra").textContent = `${extraCount} HU`;

  const label = metrics.status === "ahead" ? "Voraus"
    : metrics.status === "ok" ? "Im Plan"
      : "Rückstand";
  setStatus(metrics.status, label);
}

function setStatus(status, label) {
  const pill = document.getElementById("statusPill");
  pill.className = `statusPill ${status}`;
  pill.textContent = label;
}

function renderAchievementChart(container, { shift, now, metrics }) {
  const start = hmToMin(shift.start);
  const end = hmToMin(shift.end);
  const span = Math.max(1, end - start);
  const nowMin = dateToLocalMinutes(now);
  const toX = (minutes) => clamp(((minutes - start) / span) * 100, 0, 100);
  const toGoalX = (value) => metrics.shiftGoal > 0
    ? clamp((value / metrics.shiftGoal) * 100, 0, 100)
    : 0;

  const actualX = toGoalX(metrics.actual);
  const forecastX = toGoalX(metrics.forecast);
  const nowX = toX(nowMin);

  const breakRects = (shift.breaks || []).map((item) => {
    const left = toX(hmToMin(item.start));
    const right = toX(hmToMin(item.end));
    return `<rect x="${left}" y="18" width="${Math.max(0, right - left)}" height="28" rx="3" class="break"></rect>`;
  }).join("");

  container.innerHTML = `
    <svg class="achievementChart ${metrics.status}" viewBox="0 0 100 64" role="img" aria-label="Schichtfortschritt">
      <rect x="0" y="18" width="100" height="28" rx="6" class="axis"></rect>
      ${breakRects}
      <rect x="0" y="27" width="${actualX}" height="10" rx="5" class="actual"></rect>
      <line x1="${actualX}" y1="32" x2="${forecastX}" y2="32" class="forecast"></line>
      <line x1="${nowX}" y1="8" x2="${nowX}" y2="56" class="now"></line>
      <text x="0" y="62" class="tick">${shift.start}</text>
      <text x="50" y="62" text-anchor="middle" class="tick">Jetzt</text>
      <text x="100" y="62" text-anchor="end" class="tick">${shift.end}</text>
    </svg>
  `;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
