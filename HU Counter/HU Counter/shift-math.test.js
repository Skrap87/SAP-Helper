const assert = require("assert");
const {
  DEFAULT_SETTINGS,
  hmToMin,
  workMinutesBetween,
  getCurrentShift,
  getExtraEvents,
  getShiftEvents,
  getShiftMetrics
} = require("./src/shift-math");

const earlyShift = DEFAULT_SETTINGS.shifts[0];
const lateShift = DEFAULT_SETTINGS.shifts[1];

assert.strictEqual(hmToMin("05:00"), 300, "converts HH:MM to minutes");

assert.strictEqual(
  workMinutesBetween(earlyShift, hmToMin("05:00"), hmToMin("13:30")),
  480,
  "early shift has 480 working minutes after breaks"
);

assert.strictEqual(
  workMinutesBetween(lateShift, hmToMin("13:30"), hmToMin("22:00")),
  480,
  "late shift has 480 working minutes after breaks"
);

assert.strictEqual(
  workMinutesBetween(earlyShift, hmToMin("07:30"), hmToMin("07:40")),
  0,
  "break minutes do not count as working time"
);

assert.strictEqual(
  workMinutesBetween(earlyShift, hmToMin("07:40"), hmToMin("08:00")),
  15,
  "partly overlapping break intervals count only working minutes"
);

assert.strictEqual(
  getCurrentShift(DEFAULT_SETTINGS.shifts, new Date("2026-04-28T08:00:00")).id,
  "early",
  "08:00 belongs to early shift"
);

assert.strictEqual(
  getCurrentShift(DEFAULT_SETTINGS.shifts, new Date("2026-04-28T22:30:00"), DEFAULT_SETTINGS),
  null,
  "22:30 is outside the official late shift"
);

assert.strictEqual(
  getCurrentShift(DEFAULT_SETTINGS.shifts, new Date("2026-04-28T03:50:00"), DEFAULT_SETTINGS),
  null,
  "03:50 is outside the extra window and official early shift"
);

assert.strictEqual(
  getCurrentShift(DEFAULT_SETTINGS.shifts, new Date("2026-04-28T04:30:00"), DEFAULT_SETTINGS),
  null,
  "04:30 is extra time, not official shift time"
);

const migratedSettings = require("./src/shift-math").normalizeSettings({
  targetPerWorkHour: 60,
  extraWindows: [
    { id: "early-extra", label: "Extra vor Fruehschicht", start: "04:00", end: "05:00" },
    { id: "late-extra", label: "Extra nach Spaetschicht", start: "22:00", end: "23:00" }
  ],
  shifts: [
    { id: "early", name: "Fruehschicht", start: "05:00", end: "13:30", breaks: [] },
    { id: "late", name: "Spaetschicht", start: "13:30", end: "22:00", breaks: [] }
  ]
});

assert.strictEqual(migratedSettings.shifts[0].name, "Frühschicht", "normalizes legacy early shift name");
assert.strictEqual(migratedSettings.shifts[1].name, "Spätschicht", "normalizes legacy late shift name");
assert.strictEqual(
  migratedSettings.extraWindows[0].label,
  "Extra vor Frühschicht",
  "normalizes legacy early extra label"
);

const earlyOvertimeEvents = [
  { hu: "early-0", at: new Date(2026, 3, 28, 3, 50, 0).toISOString() },
  { hu: "early-1", at: new Date(2026, 3, 28, 4, 0, 0).toISOString() },
  { hu: "early-2", at: new Date(2026, 3, 28, 4, 30, 0).toISOString() }
];

assert.strictEqual(
  getExtraEvents(earlyOvertimeEvents, DEFAULT_SETTINGS.shifts, new Date(2026, 3, 28, 8, 0, 0), DEFAULT_SETTINGS).length,
  2,
  "early extra counts only HU between 04:00 and 05:00"
);

const lateOvertimeEvents = [
  { hu: "late-1", at: new Date(2026, 3, 28, 21, 50, 0).toISOString() },
  { hu: "late-2", at: new Date(2026, 3, 28, 22, 30, 0).toISOString() },
  { hu: "late-3", at: new Date(2026, 3, 28, 23, 10, 0).toISOString() }
];

assert.strictEqual(
  getExtraEvents(lateOvertimeEvents, DEFAULT_SETTINGS.shifts, new Date(2026, 3, 28, 23, 10, 0), DEFAULT_SETTINGS).length,
  1,
  "late extra counts only HU between 22:00 and 23:00"
);

const metrics = getShiftMetrics({
  shift: earlyShift,
  now: new Date("2026-04-28T08:00:00"),
  targetPerWorkHour: 60,
  events: [
    { hu: "1", at: "2026-04-28T05:10:00.000Z" },
    { hu: "2", at: "2026-04-28T06:10:00.000Z" },
    { hu: "3", at: "2026-04-28T07:50:00.000Z" }
  ]
});

assert.strictEqual(metrics.totalWorkMinutes, 480, "total working minutes are exposed");
assert.strictEqual(metrics.elapsedWorkMinutes, 165, "elapsed work excludes the first break");
assert.strictEqual(metrics.shiftGoal, 480, "60 HU/h over 8 work hours is 480 HU");
assert.strictEqual(metrics.expectedNow, 165, "expected progress follows effective work minutes");
assert.strictEqual(metrics.actual, 3, "actual progress counts provided shift events");
assert.strictEqual(Math.round(metrics.forecast), 9, "forecast projects current effective pace to shift end");
assert.strictEqual(metrics.status, "behind", "large negative delta is behind");

console.log("shift math tests passed");
