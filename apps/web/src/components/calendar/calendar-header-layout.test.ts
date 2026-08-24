// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import {
  allDayBandMetrics,
  CALENDAR_HEADER_LAYOUT,
  calendarTodayTarget,
  gridHeight,
  gutterWidth,
  preserveTimedScrollTop,
  timeStripLaneMinHeight,
  TIME_ZONE_GUTTER_PADDING,
  TIME_ZONE_GUTTER_WIDTH,
} from "./calendar-header-layout";
import { dayKey } from "./lib";
import { createZonedCalendarClock } from "./zoned-calendar-clock";

describe("calendar header geometry", () => {
  test("keeps the compact sticky stack deterministic", () => {
    expect(CALENDAR_HEADER_LAYOUT).toMatchObject({
      toolbarHeight: 44,
      dayStripHeight: 34,
      dayLabelAlignment: "center",
      dayLabelFlow: "inline",
      topHairline: false,
      edgeStyle: "flat",
      timeZoneOrder: "references-first-primary-last",
      continuousDividers: true,
      scrollOwner: "timed-grid",
    });
  });

  test("bounds the collapsed and expanded all-day band", () => {
    expect(allDayBandMetrics({ laneCount: 0, expanded: false })).toEqual({
      visibleRows: 1,
      height: 0,
      internallyScrollable: false,
    });
    expect(allDayBandMetrics({ laneCount: 7, expanded: true })).toEqual({
      visibleRows: 3,
      height: 108,
      internallyScrollable: true,
    });
    expect(allDayBandMetrics({ laneCount: 7, expanded: false })).toEqual({
      visibleRows: 1,
      height: 36,
      internallyScrollable: false,
    });
  });

  test("compensates the timed scroll when the sticky band changes height", () => {
    expect(
      preserveTimedScrollTop({
        scrollTop: 480,
        previousAllDayHeight: 96,
        nextAllDayHeight: 32,
      }),
    ).toBe(416);
  });

  test("sizes one to three gutters and bounds the visible grid", () => {
    expect(TIME_ZONE_GUTTER_WIDTH).toBe(48);
    expect(TIME_ZONE_GUTTER_PADDING).toBe(6);
    expect(gutterWidth(1)).toBe(60);
    expect(gutterWidth(2)).toBe(108);
    expect(gutterWidth(3)).toBe(156);
    expect(gutterWidth(1)).toBeLessThan(gutterWidth(3));
    expect(() => gutterWidth(0 as 1)).toThrow();
    expect(() => gutterWidth(4 as 3)).toThrow();
    expect(gridHeight({ startHour: 8, endHour: 18, hourHeight: 120 })).toBe(
      1200,
    );
    expect(() =>
      gridHeight({ startHour: 18, endHour: 8, hourHeight: 120 }),
    ).toThrow();
  });

  test("keeps the sticky header lane as tall as the entire timed scroll range", () => {
    expect(
      timeStripLaneMinHeight({
        startHour: 0,
        endHour: 24,
        hourHeight: 80,
        allDayHeight: 32,
      }),
    ).toBe(1_986);
  });

  test("places reference clocks before the primary planning zone", async () => {
    const layout = await import("./calendar-header-layout");
    const calendarTimeZoneColumns = (
      layout as typeof layout & {
        calendarTimeZoneColumns?: (
          primary: string,
          references: readonly string[],
        ) => ReadonlyArray<{ kind: "primary" | "reference"; timeZone: string }>;
      }
    ).calendarTimeZoneColumns;

    expect(calendarTimeZoneColumns).toBeFunction();
    if (!calendarTimeZoneColumns) return;
    expect(
      calendarTimeZoneColumns("Europe/Paris", [
        "Asia/Tokyo",
        "America/New_York",
        "Australia/Sydney",
      ]),
    ).toEqual([
      { kind: "reference", timeZone: "Asia/Tokyo" },
      { kind: "reference", timeZone: "America/New_York" },
      { kind: "primary", timeZone: "Europe/Paris" },
    ]);
  });

  test("constructs Today from the primary zone rather than the browser date", () => {
    const target = calendarTodayTarget(
      createZonedCalendarClock("America/Los_Angeles"),
      Date.parse("2026-01-01T01:00:00.000Z"),
    );

    expect([
      target.getFullYear(),
      target.getMonth() + 1,
      target.getDate(),
    ]).toEqual([2025, 12, 31]);
    expect(dayKey(target)).toBe(dayKey(new Date(2025, 11, 31)));
  });
});
