import { describe, expect, test } from "bun:test";

import {
  backoffDelayMs,
  eventMatchesWrite,
  googleEventToRemoteSnapshot,
  resolveRecurringTarget,
  trimRecurrenceBefore,
} from "../src/main/google/reconcile";

describe("Google reconciliation helpers", () => {
  test("backoff is bounded, deterministic under an injected random source, and respects Retry-After", () => {
    expect(backoffDelayMs(1, undefined, () => 0)).toBe(1_000);
    expect(backoffDelayMs(4, undefined, () => 1)).toBe(10_000);
    expect(backoffDelayMs(2, 45_000, () => 0)).toBe(45_000);
    expect(backoffDelayMs(50, undefined, () => 1)).toBe(300_000);
  });

  test("remote event mapping preserves the durable local scope", () => {
    expect(
      googleEventToRemoteSnapshot(
        {
          id: "remote-1",
          calendarId: "primary",
          etag: '"etag-2"',
          summary: "Remote",
          startMs: 10,
          endMs: 20,
          allDay: false,
          status: "confirmed",
          updatedMs: 17,
        },
        {
          accountId: "account-1",
          calendarId: "primary",
          providerCalendarId: "primary",
          localEventId: "local-1",
        },
      ),
    ).toEqual({
      remoteEtag: '"etag-2"',
      remoteUpdatedAt: 17,
      remoteSnapshot: {
        accountId: "account-1",
        allDay: false,
        calendarId: "primary",
        providerCalendarId: "primary",
        endMs: 20,
        localEventId: "local-1",
        remoteEventId: "remote-1",
        startMs: 10,
        status: "confirmed",
        summary: "Remote",
      },
    });
  });

  test("recurrence scopes resolve to occurrence, master, or a series split", () => {
    const common = {
      calendarId: "primary",
      eventId: "occurrence-1",
      recurringEventId: "master-1",
      occurrenceStartMs: Date.parse("2026-08-20T09:00:00Z"),
    };
    expect(resolveRecurringTarget({ ...common, scope: "thisEvent" })).toEqual({
      kind: "primitive",
      target: { calendarId: "primary", eventId: "occurrence-1" },
    });
    expect(resolveRecurringTarget({ ...common, scope: "allEvents" })).toEqual({
      kind: "primitive",
      target: { calendarId: "primary", eventId: "master-1" },
    });
    expect(
      resolveRecurringTarget({ ...common, scope: "thisAndFollowing" }),
    ).toEqual({
      kind: "split",
      master: { calendarId: "primary", eventId: "master-1" },
      splitAtMs: Date.parse("2026-08-20T09:00:00Z"),
    });
  });

  test("this-and-following trims every RRULE before the chosen occurrence", () => {
    expect(
      trimRecurrenceBefore(
        ["RRULE:FREQ=WEEKLY;COUNT=12", "EXDATE:20260813T090000Z"],
        Date.parse("2026-08-20T09:00:00Z"),
      ),
    ).toEqual([
      "RRULE:FREQ=WEEKLY;UNTIL=20260820T085959Z",
      "EXDATE:20260813T090000Z",
    ]);
  });

  test("conference removal requires every retained conference marker to be absent", () => {
    expect(
      eventMatchesWrite(
        {
          id: "remote-1",
          calendarId: "primary",
          status: "confirmed",
          conferenceName: "Google Meet",
          conferenceType: "hangoutsMeet",
        },
        { conference: "remove" },
      ),
    ).toBe(false);
  });
});
