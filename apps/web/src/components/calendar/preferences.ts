import type { CalendarView } from "./lib";

export const CALENDAR_PREFERENCES_STORAGE_KEY = "qali.calendar.preferences.v1";

export const CALENDAR_HOUR_HEIGHTS = [64, 80, 96] as const;
export type CalendarHourHeight = (typeof CALENDAR_HOUR_HEIGHTS)[number];

export interface CalendarTimeRange {
  startHour: number;
  endHour: number;
}

export interface CalendarPreferences {
  dayStartHour: number;
  dayEndHour: number;
  hourHeight: CalendarHourHeight;
  defaultView: CalendarView;
}

export const DEFAULT_CALENDAR_PREFERENCES: CalendarPreferences = Object.freeze({
  dayStartHour: 0,
  dayEndHour: 24,
  hourHeight: 96,
  defaultView: "week",
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCalendarPreferences(
  serialized: string | null,
): CalendarPreferences {
  if (!serialized) return DEFAULT_CALENDAR_PREFERENCES;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isPlainObject(value)) return DEFAULT_CALENDAR_PREFERENCES;
    if (
      Object.keys(value).sort().join(",") !==
      "dayEndHour,dayStartHour,defaultView,hourHeight"
    ) {
      return DEFAULT_CALENDAR_PREFERENCES;
    }
    const { dayStartHour, dayEndHour, hourHeight, defaultView } = value;
    if (
      !Number.isInteger(dayStartHour) ||
      !Number.isInteger(dayEndHour) ||
      typeof dayStartHour !== "number" ||
      typeof dayEndHour !== "number" ||
      dayStartHour < 0 ||
      dayStartHour > 23 ||
      dayEndHour < 1 ||
      dayEndHour > 24 ||
      dayEndHour <= dayStartHour ||
      !CALENDAR_HOUR_HEIGHTS.includes(hourHeight as CalendarHourHeight) ||
      (defaultView !== "day" &&
        defaultView !== "week" &&
        defaultView !== "month")
    ) {
      return DEFAULT_CALENDAR_PREFERENCES;
    }
    return {
      dayStartHour,
      dayEndHour,
      hourHeight: hourHeight as CalendarHourHeight,
      defaultView,
    };
  } catch {
    return DEFAULT_CALENDAR_PREFERENCES;
  }
}

export function preferenceTimeRange(
  preferences: CalendarPreferences,
): CalendarTimeRange {
  return {
    startHour: preferences.dayStartHour,
    endHour: preferences.dayEndHour,
  };
}

export function timeRangeMinutes(range: CalendarTimeRange): number {
  return (range.endHour - range.startHour) * 60;
}

export function timeRangeHeight(
  range: CalendarTimeRange,
  hourHeight: number,
): number {
  return (range.endHour - range.startHour) * hourHeight;
}

export function timeRangePct(
  minutesFromMidnight: number,
  range: CalendarTimeRange,
): number {
  const minutes = timeRangeMinutes(range);
  return (
    ((Math.min(
      Math.max(minutesFromMidnight, range.startHour * 60),
      range.endHour * 60,
    ) -
      range.startHour * 60) /
      minutes) *
    100
  );
}

export function instantToTimeRangePct(
  instantMs: number,
  dayStartMs: number,
  range: CalendarTimeRange,
): number {
  return timeRangePct((instantMs - dayStartMs) / 60_000, range);
}

export function snappedMsFromVisibleOffsetY(
  offsetY: number,
  dayStartMs: number,
  dayHeightPx: number,
  range: CalendarTimeRange,
): number {
  return (
    dayStartMs +
    snappedMinuteFromVisibleOffsetY(offsetY, dayHeightPx, range) * 60_000
  );
}

/** Snap pointer geometry to a primary-zone civil minute. The zoned clock, not
 * elapsed milliseconds from midnight, owns conversion of this value to an
 * instant on DST transition days. */
export function snappedMinuteFromVisibleOffsetY(
  offsetY: number,
  dayHeightPx: number,
  range: CalendarTimeRange,
): number {
  const snapMinutes = 15;
  const rangeMinutes = timeRangeMinutes(range);
  const clampedY = Math.min(Math.max(offsetY, 0), dayHeightPx);
  const steps = Math.round(
    (clampedY / Math.max(dayHeightPx, 1)) * (rangeMinutes / snapMinutes),
  );
  return range.startHour * 60 + steps * snapMinutes;
}
