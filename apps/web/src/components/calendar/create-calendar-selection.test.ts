// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { resolveCreateCalendarId } from "./create-calendar-selection";

const calendars = [
  {
    googleCalendarId: "primary@example.com",
    accessRole: "owner",
    primary: true,
  },
  {
    googleCalendarId: "team@example.com",
    accessRole: "writer",
    primary: false,
  },
  {
    googleCalendarId: "holidays@example.com",
    accessRole: "reader",
    primary: false,
  },
] as const;

describe("new-event calendar selection", () => {
  test("uses the configured writable default before the account primary", () => {
    expect(
      resolveCreateCalendarId(calendars, undefined, "team@example.com"),
    ).toBe("team@example.com");
  });

  test("keeps an explicit form selection ahead of the configured default", () => {
    expect(
      resolveCreateCalendarId(
        calendars,
        "primary@example.com",
        "team@example.com",
      ),
    ).toBe("primary@example.com");
  });

  test("falls back safely when a stored default is missing or read-only", () => {
    expect(
      resolveCreateCalendarId(calendars, undefined, "holidays@example.com"),
    ).toBe("primary@example.com");
    expect(
      resolveCreateCalendarId(calendars, undefined, "removed@example.com"),
    ).toBe("primary@example.com");
  });
});
