// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CALENDAR_PREFERENCES,
  parseCalendarPreferences,
  timeRangeHeight,
  timeRangePct,
  snappedMsFromVisibleOffsetY,
} from "./preferences";

describe("calendar preferences", () => {
  test("defaults to a spacious, full-day week without trusting malformed storage", () => {
    expect(parseCalendarPreferences(null)).toEqual(
      DEFAULT_CALENDAR_PREFERENCES,
    );
    expect(parseCalendarPreferences("not json")).toEqual(
      DEFAULT_CALENDAR_PREFERENCES,
    );
    expect(
      parseCalendarPreferences(JSON.stringify({ dayStartHour: -1 })),
    ).toEqual(DEFAULT_CALENDAR_PREFERENCES);
  });

  test("accepts only bounded display settings", () => {
    const value = {
      dayStartHour: 6,
      dayEndHour: 22,
      hourHeight: 96,
      defaultView: "day",
    } as const;
    expect(parseCalendarPreferences(JSON.stringify(value))).toEqual(value);
    expect(
      parseCalendarPreferences(JSON.stringify({ ...value, dayEndHour: 6 })),
    ).toEqual(DEFAULT_CALENDAR_PREFERENCES);
    expect(
      parseCalendarPreferences(JSON.stringify({ ...value, hourHeight: 70 })),
    ).toEqual(DEFAULT_CALENDAR_PREFERENCES);
  });

  test("maps and clips wall-clock time into the configured visible range", () => {
    const range = { startHour: 6, endHour: 22 };
    expect(timeRangePct(6 * 60, range)).toBe(0);
    expect(timeRangePct(14 * 60, range)).toBe(50);
    expect(timeRangePct(23 * 60, range)).toBe(100);
    expect(timeRangeHeight(range, 96)).toBe(1_536);
  });

  test("snaps pointer positions to 15-minute marks inside the visible range", () => {
    const dayStartMs = new Date(2026, 7, 19).setHours(0, 0, 0, 0);
    const range = { startHour: 6, endHour: 22 };
    expect(snappedMsFromVisibleOffsetY(0, dayStartMs, 1_600, range)).toBe(
      dayStartMs + 6 * 60 * 60_000,
    );
    expect(snappedMsFromVisibleOffsetY(812, dayStartMs, 1_600, range)).toBe(
      dayStartMs + 14 * 60 * 60_000,
    );
    expect(snappedMsFromVisibleOffsetY(2_000, dayStartMs, 1_600, range)).toBe(
      dayStartMs + 22 * 60 * 60_000,
    );
  });
});
