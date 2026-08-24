// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  civilIntervalPlacement,
  timeGridPlacement,
  timeGridSlots,
  timeGutterLabels,
} from "./time-gutter";
import { moveStartForCivilMinute } from "./use-event-drag";
import {
  createZonedCalendarClock,
  parseCivilDate,
} from "./zoned-calendar-clock";

describe("time gutter projections", () => {
  const paris = createZonedCalendarClock("Europe/Paris");

  test("renders at most three zones and keeps endpoints inside the range", () => {
    const labels = timeGutterLabels({
      clock: paris,
      date: parseCivilDate("2026-01-15"),
      timeRange: { startHour: 8, endHour: 18 },
      timeZones: ["Europe/Paris", "Asia/Tokyo", "America/New_York"],
    });

    expect(new Set(labels.map(({ zone }) => zone))).toEqual(
      new Set(["Europe/Paris", "Asia/Tokyo", "America/New_York"]),
    );
    expect(labels.every(({ topPct }) => topPct > 0 && topPct < 100)).toBe(true);
    expect(() =>
      timeGutterLabels({
        clock: paris,
        date: parseCivilDate("2026-01-15"),
        timeRange: { startHour: 8, endHour: 18 },
        timeZones: ["Europe/Paris", "UTC", "Asia/Tokyo", "America/New_York"],
      }),
    ).toThrow();
  });

  test("formats each reference clock as a compact 24-hour column", () => {
    const labels = timeGutterLabels({
      clock: paris,
      date: parseCivilDate("2026-01-15"),
      timeRange: { startHour: 8, endHour: 10 },
      timeZones: ["Asia/Tokyo", "Europe/Paris"],
    }).filter(({ minute }) => minute === 9 * 60);

    expect(labels.map(({ zone, label }) => ({ zone, label }))).toEqual([
      { zone: "Asia/Tokyo", label: "17:00" },
      { zone: "Europe/Paris", label: "09:00" },
    ]);
  });

  test("keeps repeated hours in one civil row with instant, offset, and fold identity", () => {
    const labels = timeGutterLabels({
      clock: paris,
      date: parseCivilDate("2026-10-25"),
      timeRange: { startHour: 0, endHour: 6 },
      timeZones: ["Europe/Paris"],
    }).filter(({ minute }) => minute === 2 * 60);

    expect(
      labels.map(({ instantMs, offsetMinutes, fold }) => ({
        instantMs,
        offsetMinutes,
        fold,
      })),
    ).toEqual([
      {
        instantMs: Date.parse("2026-10-25T00:00:00.000Z"),
        offsetMinutes: 120,
        fold: 0,
      },
      {
        instantMs: Date.parse("2026-10-25T01:00:00.000Z"),
        offsetMinutes: 60,
        fold: 1,
      },
    ]);
    expect(labels[0]?.topPct).toBeCloseTo(100 / 3);
    expect(labels[1]?.topPct).toBeCloseTo(100 / 3);
  });

  test("marks spring-forward gaps non-droppable while preserving adjacent slots", () => {
    const slots = timeGridSlots({
      clock: paris,
      date: parseCivilDate("2026-03-29"),
      timeRange: { startHour: 1, endHour: 4 },
      stepMinutes: 15,
    });

    expect(
      slots
        .filter(({ minute }) => minute >= 2 * 60 && minute < 3 * 60)
        .every(({ droppable, occurrences }) =>
          !droppable && occurrences.length === 0,
        ),
    ).toBe(true);
    expect(slots.find(({ minute }) => minute === 105)?.droppable).toBe(true);
    expect(slots.find(({ minute }) => minute === 180)?.droppable).toBe(true);
  });

  test("places an event spanning a transition by civil rows", () => {
    expect(
      timeGridPlacement({
        clock: paris,
        date: parseCivilDate("2026-03-29"),
        startMs: Date.parse("2026-03-29T00:30:00.000Z"),
        endMs: Date.parse("2026-03-29T01:30:00.000Z"),
        timeRange: { startHour: 0, endHour: 6 },
      }),
    ).toEqual({
      topPct: 25,
      heightPct: 100 / 3,
    });
  });

  test("derives spring-forward block instants and placement from civil minutes", () => {
    expect(
      civilIntervalPlacement({
        clock: paris,
        date: parseCivilDate("2026-03-29"),
        startMinute: 90,
        endMinute: 210,
        timeRange: { startHour: 0, endHour: 6 },
      }),
    ).toEqual({
      startMs: Date.parse("2026-03-29T00:30:00.000Z"),
      endMs: Date.parse("2026-03-29T01:30:00.000Z"),
      topPct: 25,
      heightPct: 100 / 3,
    });
  });

  test("preserves the source fold when moving within a repeated hour", () => {
    expect(
      moveStartForCivilMinute({
        clock: paris,
        date: parseCivilDate("2026-10-25"),
        minute: 150,
        preferredFold: 1,
        durationMs: 30 * 60_000,
        visibleStartMs: paris.day(parseCivilDate("2026-10-25")).startMs,
        visibleEndMs: paris.day(parseCivilDate("2026-10-25")).endMs,
      }),
    ).toBe(Date.parse("2026-10-25T01:30:00.000Z"));
  });
});
