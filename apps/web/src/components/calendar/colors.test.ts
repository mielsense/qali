// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

process.env.SKIP_ENV_VALIDATION = "1";
const { CALENDAR_COLOR_CHOICES, calendarColorVar } = await import("./colors");

describe("calendar color preferences", () => {
  test("a local calendar color overrides Google's display color", () => {
    expect(
      calendarColorVar({
        googleCalendarId: "primary@example.com",
        backgroundColor: "#039be5",
        colorOverride: "event-7",
      }),
    ).toBe("--event-7");
  });

  test("the picker exposes the complete bounded Qali palette", () => {
    expect(CALENDAR_COLOR_CHOICES.map((choice) => choice.key)).toEqual([
      "event-1",
      "event-2",
      "event-3",
      "event-4",
      "event-5",
      "event-6",
      "event-7",
      "event-8",
      "event-neutral",
    ]);
  });
});
