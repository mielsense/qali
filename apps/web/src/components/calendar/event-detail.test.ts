// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

process.env.SKIP_ENV_VALIDATION = "1";
const { recurringDeleteScopes, shareableEventLinks } = await import(
  "./event-detail"
);

describe("recurring event delete scopes", () => {
  test("organizers can choose occurrence, future, or whole series", () => {
    expect(recurringDeleteScopes(true).map((option) => option.scope)).toEqual([
      "thisEvent",
      "thisAndFollowing",
      "allEvents",
    ]);
  });

  test("guests can remove one occurrence or their whole series copy", () => {
    expect(recurringDeleteScopes(false).map((option) => option.scope)).toEqual([
      "thisEvent",
      "allEvents",
    ]);
  });

  test("scope choices contain no second-step confirmation state", () => {
    expect(
      recurringDeleteScopes(true).every(
        (option) => !("confirmLabel" in option),
      ),
    ).toBe(true);
  });
});

describe("shareable event links", () => {
  test("keeps only public HTTPS conference and Google Calendar links", () => {
    expect(
      shareableEventLinks(
        {
          conferenceUrl: "qali://event/local-id",
          hangoutLink: "https://meet.google.com/abc-defg-hij",
          htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
        },
        "qali-app://renderer",
      ),
    ).toEqual({
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
    });
  });

  test("does not substitute private or local application links", () => {
    expect(
      shareableEventLinks(
        {
          conferenceUrl: "http://127.0.0.1:3000/call",
          hangoutLink: "file:///tmp/call",
          htmlLink: "qali-app://renderer/event/1",
        },
        "qali-app://renderer",
      ),
    ).toEqual({});
  });
});
