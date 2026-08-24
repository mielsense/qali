// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { buildCalendarInsights } from "./calendar-insights";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 21, 12);

describe("calendar insights", () => {
  test("summarizes timed, non-cancelled events without inflating all-day blocks", () => {
    const insights = buildCalendarInsights(
      [
        { startMs: NOW - DAY, endMs: NOW - DAY + 60 * 60_000 },
        { startMs: NOW, endMs: NOW + 30 * 60_000 },
        { startMs: NOW, endMs: NOW + DAY, allDay: true },
        {
          startMs: NOW - 2 * DAY,
          endMs: NOW - 2 * DAY + 60 * 60_000,
          status: "cancelled",
        },
      ],
      NOW,
      "UTC",
    );

    expect(insights.eventCount).toBe(2);
    expect(insights.scheduledHours).toBe(1.5);
    expect(insights.averageEventMinutes).toBe(45);
    expect(insights.activeDays).toBe(2);
    expect(insights.longestEventMinutes).toBe(60);
    expect(insights.daily).toHaveLength(28);
    expect(insights.daily.at(-1)?.hours).toBe(0.5);
    expect(insights.dayparts).toEqual([
      { label: "Morning", hours: 0 },
      { label: "Afternoon", hours: 1.5 },
      { label: "Evening", hours: 0 },
      { label: "Night", hours: 0 },
    ]);
  });

  test("keeps a stable 28-day series and identifies the busiest weekday", () => {
    const insights = buildCalendarInsights(
      [
        { startMs: NOW, endMs: NOW + 2 * 60 * 60_000 },
        { startMs: NOW - 7 * DAY, endMs: NOW - 7 * DAY + 60 * 60_000 },
      ],
      NOW,
      "UTC",
    );

    expect(insights.daily).toHaveLength(28);
    expect(insights.busiestWeekday).toBe("Friday");
    expect(insights.weekdays.reduce((sum, day) => sum + day.hours, 0)).toBe(3);
  });
});
