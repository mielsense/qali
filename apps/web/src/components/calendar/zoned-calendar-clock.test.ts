// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { gutterTotalForSecondaryZoneCount, GUTTER_WIDTH } from "./lib";
import { snappedMinuteFromVisibleOffsetY } from "./preferences";
import {
  createZonedCalendarClock,
  normalizeTimeZone,
  parseCivilDate,
  UnsupportedTimeZoneError,
} from "./zoned-calendar-clock";

const date = parseCivilDate;

describe("ZonedCalendarClock day boundaries", () => {
  const paris = createZonedCalendarClock("Europe/Paris");

  test("uses the real 23-hour spring-forward day", () => {
    const day = paris.day(date("2026-03-29"));

    expect(day).toEqual({
      key: date("2026-03-29"),
      startMs: Date.parse("2026-03-28T23:00:00.000Z"),
      endMs: Date.parse("2026-03-29T22:00:00.000Z"),
    });
    expect(day.endMs - day.startMs).toBe(23 * 3_600_000);
  });

  test("uses the real 25-hour fall-back day", () => {
    const day = paris.day(date("2026-10-25"));

    expect(day).toEqual({
      key: date("2026-10-25"),
      startMs: Date.parse("2026-10-24T22:00:00.000Z"),
      endMs: Date.parse("2026-10-25T23:00:00.000Z"),
    });
    expect(day.endMs - day.startMs).toBe(25 * 3_600_000);
  });
});

describe("ZonedCalendarClock DST disambiguation", () => {
  const paris = createZonedCalendarClock("Europe/Paris");

  test("compatible shifts a nonexistent time forward by the gap", () => {
    expect(
      paris.wallTimeToInstant(date("2026-03-29"), 2 * 60 + 30, "compatible"),
    ).toEqual({
      kind: "gap-shifted",
      instantMs: Date.parse("2026-03-29T01:30:00.000Z"),
      offsetMinutes: 120,
      requestedMinute: 150,
      resolvedMinute: 210,
      fold: 0,
    });
  });

  test("earlier shifts a nonexistent time backward and reject returns gap metadata", () => {
    expect(
      paris.wallTimeToInstant(date("2026-03-29"), 150, "earlier"),
    ).toEqual({
      kind: "gap-shifted",
      instantMs: Date.parse("2026-03-29T00:30:00.000Z"),
      offsetMinutes: 60,
      requestedMinute: 150,
      resolvedMinute: 90,
      fold: 0,
    });
    expect(
      paris.wallTimeToInstant(date("2026-03-29"), 150, "reject"),
    ).toEqual({
      kind: "rejected",
      reason: "gap",
      requestedMinute: 150,
      candidates: [],
    });
  });

  test("retains both exact instant, offset, and fold identities in an overlap", () => {
    const earlier = paris.wallTimeToInstant(
      date("2026-10-25"),
      2 * 60 + 30,
      "earlier",
    );
    const later = paris.wallTimeToInstant(
      date("2026-10-25"),
      2 * 60 + 30,
      "later",
    );

    expect(earlier).toEqual({
      kind: "ambiguous",
      instantMs: Date.parse("2026-10-25T00:30:00.000Z"),
      offsetMinutes: 120,
      requestedMinute: 150,
      resolvedMinute: 150,
      fold: 0,
    });
    expect(later).toEqual({
      kind: "ambiguous",
      instantMs: Date.parse("2026-10-25T01:30:00.000Z"),
      offsetMinutes: 60,
      requestedMinute: 150,
      resolvedMinute: 150,
      fold: 1,
    });
    if (earlier.kind === "rejected" || later.kind === "rejected") {
      throw new Error("Earlier/later overlap disambiguation must select an instant");
    }
    expect(earlier.instantMs).not.toBe(later.instantMs);
  });

  test("compatible chooses the earlier overlap and reject exposes both candidates", () => {
    const compatible = paris.wallTimeToInstant(
      date("2026-10-25"),
      150,
      "compatible",
    );
    const rejected = paris.wallTimeToInstant(
      date("2026-10-25"),
      150,
      "reject",
    );

    expect(compatible.kind).toBe("ambiguous");
    expect("fold" in compatible ? compatible.fold : undefined).toBe(0);
    expect(rejected).toEqual({
      kind: "rejected",
      reason: "ambiguous",
      requestedMinute: 150,
      candidates: [
        {
          instantMs: Date.parse("2026-10-25T00:30:00.000Z"),
          offsetMinutes: 120,
          fold: 0,
        },
        {
          instantMs: Date.parse("2026-10-25T01:30:00.000Z"),
          offsetMinutes: 60,
          fold: 1,
        },
      ],
    });
  });

  test("projects the later overlap instant back to its offset-qualified fold", () => {
    const instantMs = Date.parse("2026-10-25T01:30:00.000Z");

    expect(paris.instantToWallTime(instantMs)).toEqual({
      date: date("2026-10-25"),
      minute: 150,
      instantMs,
      offsetMinutes: 60,
      fold: 1,
    });
  });
});

describe("ZonedCalendarClock projections", () => {
  const paris = createZonedCalendarClock("Europe/Paris");

  test("projects one primary tick into Tokyo and New York", () => {
    expect(
      paris.secondaryLabelsForTick(date("2026-01-15"), 15 * 60, [
        "Asia/Tokyo",
        "America/New_York",
      ]),
    ).toEqual([
      {
        zone: "Asia/Tokyo",
        instantMs: Date.parse("2026-01-15T14:00:00.000Z"),
        minute: 23 * 60,
        offsetMinutes: 540,
        fold: 0,
        label: "23:00 UTC+09:00",
      },
      {
        zone: "America/New_York",
        instantMs: Date.parse("2026-01-15T14:00:00.000Z"),
        minute: 9 * 60,
        offsetMinutes: -300,
        fold: 0,
        label: "09:00 UTC-05:00",
      },
    ]);
  });

  test("ambiguous secondary labels retain distinct instant, offset, and fold identities", () => {
    const labels = paris.secondaryLabelsForTick(
      date("2026-10-25"),
      150,
      ["Europe/Paris"],
    );

    expect(labels).toHaveLength(2);
    expect(
      labels.map(({ instantMs, offsetMinutes, fold, label }) => ({
        instantMs,
        offsetMinutes,
        fold,
        label,
      })),
    ).toEqual([
      {
        instantMs: Date.parse("2026-10-25T00:30:00.000Z"),
        offsetMinutes: 120,
        fold: 0,
        label: "02:30 UTC+02:00",
      },
      {
        instantMs: Date.parse("2026-10-25T01:30:00.000Z"),
        offsetMinutes: 60,
        fold: 1,
        label: "02:30 UTC+01:00",
      },
    ]);
  });

  test("changing the primary zone changes today without rewriting an instant", () => {
    const instantMs = Date.parse("2026-01-15T23:30:00.000Z");

    expect(createZonedCalendarClock("Europe/Paris").today(instantMs)).toBe(
      "2026-01-16",
    );
    expect(createZonedCalendarClock("America/New_York").today(instantMs)).toBe(
      "2026-01-15",
    );
  });

  test("all-day civil dates remain stable across zones", () => {
    const allDayDate = date("2026-03-29");

    expect(paris.addDays(allDayDate, 1)).toBe("2026-03-30");
    expect(createZonedCalendarClock("Asia/Tokyo").addDays(allDayDate, 1)).toBe(
      "2026-03-30",
    );
  });
});

describe("timezone and civil-date validation", () => {
  test("normalizes a supported legacy alias to the runtime canonical zone", () => {
    expect(normalizeTimeZone("US/Eastern")).toEqual({
      ok: true,
      timeZone: "America/New_York",
    });
    expect(createZonedCalendarClock("US/Eastern").primaryTimeZone).toBe(
      "America/New_York",
    );
  });

  test("returns typed unsupported-zone metadata and rejects clock construction", () => {
    expect(normalizeTimeZone("Mars/Olympus")).toEqual({
      ok: false,
      error: {
        code: "UNSUPPORTED_TIME_ZONE",
        timeZone: "Mars/Olympus",
      },
    });
    expect(() => createZonedCalendarClock("Mars/Olympus")).toThrow(
      UnsupportedTimeZoneError,
    );
  });

  test("constructs CivilDate only from strict, real YYYY-MM-DD values", () => {
    expect(parseCivilDate("2026-02-28")).toBe("2026-02-28");
    expect(() => parseCivilDate("2026-2-28")).toThrow(RangeError);
    expect(() => parseCivilDate("2026-02-29")).toThrow(RangeError);
    expect(() => parseCivilDate("2026-13-01")).toThrow(RangeError);
  });
});

describe("calendar wall-clock helpers", () => {
  test("sizes the gutter from one primary and zero to two secondary zones", () => {
    expect(gutterTotalForSecondaryZoneCount(0)).toBe(GUTTER_WIDTH);
    expect(gutterTotalForSecondaryZoneCount(2)).toBe(3 * GUTTER_WIDTH);
    expect(() => gutterTotalForSecondaryZoneCount(3)).toThrow(RangeError);
  });

  test("snaps pointer geometry to a civil minute without constructing an instant", () => {
    expect(
      snappedMinuteFromVisibleOffsetY(812, 1_600, {
        startHour: 6,
        endHour: 22,
      }),
    ).toBe(14 * 60);
  });
});
