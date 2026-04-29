(function (root) {
  "use strict";

  const DEFAULT_SETTINGS = {
    targetPerWorkHour: 60,
    extraWindows: [
      { id: "early-extra", label: "Extra vor Frühschicht", start: "04:00", end: "05:00" },
      { id: "late-extra", label: "Extra nach Spätschicht", start: "22:00", end: "23:00" }
    ],
    shifts: [
      {
        id: "early",
        name: "Frühschicht",
        start: "05:00",
        end: "13:30",
        breaks: [
          { start: "07:30", end: "07:45", label: "Pause" },
          { start: "10:30", end: "10:45", label: "Pause" }
        ]
      },
      {
        id: "late",
        name: "Spätschicht",
        start: "13:30",
        end: "22:00",
        breaks: [
          { start: "16:00", end: "16:15", label: "Pause" },
          { start: "19:45", end: "20:00", label: "Pause" }
        ]
      }
    ]
  };

  function hmToMin(hm) {
    const [hours, minutes] = String(hm || "00:00").split(":").map(Number);
    return hours * 60 + minutes;
  }

  function dateToLocalMinutes(date) {
    const value = date instanceof Date ? date : new Date(date);
    return value.getHours() * 60 + value.getMinutes();
  }

  function formatHmFromMin(minutes) {
    const safeMinutes = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
    const hours = Math.floor(safeMinutes / 60);
    const mins = safeMinutes % 60;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  }

  function overlapMinutes(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  }

  function breakMinutesWithin(shift, fromMin, toMin) {
    return getBreaks(shift).reduce((sum, item) => {
      return sum + overlapMinutes(fromMin, toMin, hmToMin(item.start), hmToMin(item.end));
    }, 0);
  }

  function workMinutesBetween(shift, fromMin, toMin) {
    if (!shift) {
      return 0;
    }

    const shiftStart = hmToMin(shift.start);
    const shiftEnd = hmToMin(shift.end);
    const start = Math.max(fromMin, shiftStart);
    const end = Math.min(toMin, shiftEnd);

    if (end <= start) {
      return 0;
    }

    return Math.max(0, end - start - breakMinutesWithin(shift, start, end));
  }

  function getCurrentShift(shifts, date = new Date(), settings = DEFAULT_SETTINGS) {
    const nowMin = dateToLocalMinutes(date);
    return (shifts || []).find((shift) => {
      return nowMin >= hmToMin(shift.start) && nowMin < hmToMin(shift.end);
    }) || null;
  }

  function getShiftEvents(events, shift, date = new Date()) {
    if (!shift) {
      return [];
    }

    const dayKey = toDayKey(date);
    const shiftStart = hmToMin(shift.start);
    const shiftEnd = hmToMin(shift.end);

    return (events || []).filter((event) => {
      if (!event || !event.at) {
        return false;
      }

      const eventDate = new Date(event.at);
      const eventMin = dateToLocalMinutes(eventDate);
      return toDayKey(eventDate) === dayKey && eventMin >= shiftStart && eventMin < shiftEnd;
    });
  }

  function getExtraEvents(events, shifts, date = new Date(), settings = DEFAULT_SETTINGS) {
    const dayKey = toDayKey(date);
    const normalized = normalizeSettings(settings);
    return (events || []).filter((event) => {
      if (!event || !event.at) {
        return false;
      }

      const eventDate = new Date(event.at);
      if (toDayKey(eventDate) !== dayKey) {
        return false;
      }

      const eventMin = dateToLocalMinutes(eventDate);
      return normalized.extraWindows.some((window) => {
        return eventMin >= hmToMin(window.start) && eventMin < hmToMin(window.end);
      }) && !getCurrentShift(shifts, eventDate, normalized);
    });
  }

  function getDisplayShift(shifts, date = new Date(), settings = DEFAULT_SETTINGS) {
    const current = getCurrentShift(shifts, date, settings);
    if (current) {
      return current;
    }

    const nowMin = dateToLocalMinutes(date);
    const shiftList = shifts || [];
    const lastFinished = [...shiftList].reverse().find((shift) => nowMin >= hmToMin(shift.end));
    if (lastFinished) {
      return lastFinished;
    }

    return shiftList[0] || null;
  }

  function getShiftMetrics({ shift, now = new Date(), targetPerWorkHour, events }) {
    if (!shift) {
      return createEmptyMetrics();
    }

    const nowMin = dateToLocalMinutes(now);
    const shiftStart = hmToMin(shift.start);
    const shiftEnd = hmToMin(shift.end);
    const totalWorkMinutes = workMinutesBetween(shift, shiftStart, shiftEnd);
    const elapsedWorkMinutes = workMinutesBetween(shift, shiftStart, nowMin);
    const target = Number(targetPerWorkHour) || DEFAULT_SETTINGS.targetPerWorkHour;
    const actual = (events || []).length;
    const shiftGoal = target * (totalWorkMinutes / 60);
    const expectedNow = target * (elapsedWorkMinutes / 60);
    const pacePerWorkHour = elapsedWorkMinutes > 0 ? actual / (elapsedWorkMinutes / 60) : 0;
    const forecast = pacePerWorkHour * (totalWorkMinutes / 60);
    const delta = actual - expectedNow;

    return {
      totalWorkMinutes,
      elapsedWorkMinutes,
      shiftGoal,
      expectedNow,
      actual,
      pacePerWorkHour,
      forecast,
      delta,
      status: getStatus(delta)
    };
  }

  function getStatus(delta) {
    if (delta >= 5) {
      return "ahead";
    }
    if (delta >= -5) {
      return "ok";
    }
    return "behind";
  }

  function normalizeSettings(value) {
    const settings = value && typeof value === "object" ? value : {};
    return {
      targetPerWorkHour: Number(settings.targetPerWorkHour) || DEFAULT_SETTINGS.targetPerWorkHour,
      extraWindows: normalizeExtraWindows(settings.extraWindows),
      shifts: normalizeShifts(settings.shifts)
    };
  }

  function toDayKey(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0")
    ].join("-");
  }

  function getBreaks(shift) {
    return Array.isArray(shift?.breaks) ? shift.breaks : [];
  }

  function normalizeExtraWindows(value) {
    const windows = Array.isArray(value) && value.length > 0 ? value : DEFAULT_SETTINGS.extraWindows;
    return windows.map((window) => ({
      ...window,
      label: normalizeGermanLabel(window.label)
    }));
  }

  function normalizeShifts(value) {
    const shifts = Array.isArray(value) && value.length > 0 ? value : DEFAULT_SETTINGS.shifts;
    return shifts.map((shift) => ({
      ...shift,
      name: normalizeGermanLabel(shift.name),
      breaks: getBreaks(shift).map((item) => ({
        ...item,
        label: normalizeGermanLabel(item.label)
      }))
    }));
  }

  function normalizeGermanLabel(value) {
    if (typeof value !== "string") {
      return value;
    }

    return value
      .replaceAll("Fruehschicht", "Frühschicht")
      .replaceAll("Spaetschicht", "Spätschicht")
      .replaceAll("Rueckstand", "Rückstand")
      .replaceAll("Ausserhalb", "Außerhalb")
      .replaceAll("zuruecksetzen", "zurücksetzen");
  }

  function createEmptyMetrics() {
    return {
      totalWorkMinutes: 0,
      elapsedWorkMinutes: 0,
      shiftGoal: 0,
      expectedNow: 0,
      actual: 0,
      pacePerWorkHour: 0,
      forecast: 0,
      delta: 0,
      status: "outside"
    };
  }

  const api = {
    DEFAULT_SETTINGS,
    hmToMin,
    dateToLocalMinutes,
    formatHmFromMin,
    overlapMinutes,
    breakMinutesWithin,
    workMinutesBetween,
    getCurrentShift,
    getDisplayShift,
    getShiftEvents,
    getExtraEvents,
    getShiftMetrics,
    getStatus,
    normalizeSettings,
    toDayKey
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.HuCounterShiftMath = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
