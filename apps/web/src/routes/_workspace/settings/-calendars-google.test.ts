// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  LEGACY_CREDENTIAL_RECOVERY_BUTTON_LABEL,
  LEGACY_CREDENTIAL_RECOVERY_CONFIRMATION,
  calendarLabelForAccount,
  legacyCredentialRecoveryAvailable,
} from "./calendars-google";

const source = readFileSync(
  new URL("./calendars-google.tsx", import.meta.url),
  "utf8",
);

test("renders Google account groups as flat settings sections", () => {
  expect(source).toContain("function GoogleAccountSection");
  expect(source).toContain('id="google-calendar-accounts"');
  expect(source).toContain("<SettingsTarget");
  expect(source).toContain("space-y-7");
  expect(source).not.toContain("function GoogleAccountCard");
  expect(source).not.toContain("shadow-card");
  expect(source).not.toContain("backdrop-blur-md");
  expect(source).not.toContain("bg-card/70");
});

test("qualifies duplicate Google calendar labels with their account email", () => {
  const first = {
    googleCalendarId: "gcal_first",
    summary: "Work",
    summaryOverride: undefined,
  };
  const second = {
    googleCalendarId: "gcal_second",
    summary: "work",
    summaryOverride: undefined,
  };
  const personal = {
    googleCalendarId: "gcal_personal",
    summary: "Personal",
    summaryOverride: undefined,
  };

  expect(
    calendarLabelForAccount(
      first,
      [first, second, personal],
      "one@example.com",
    ),
  ).toBe("Work — one@example.com");
  expect(
    calendarLabelForAccount(
      second,
      [first, second, personal],
      "two@example.com",
    ),
  ).toBe("work — two@example.com");
  expect(
    calendarLabelForAccount(
      personal,
      [first, second, personal],
      "one@example.com",
    ),
  ).toBe("Personal");
});

test("offers legacy authorization recovery only for the explicit global residue state", () => {
  expect(
    legacyCredentialRecoveryAvailable({
      kind: "unavailable",
      message: "Old authorization found.",
      recoveryRequired: "legacy-credentials",
      recoveryAction: "clear-legacy-credentials",
    }),
  ).toBe(true);
  expect(
    legacyCredentialRecoveryAvailable({
      kind: "unavailable",
      message: "Google Calendar is temporarily unavailable.",
    }),
  ).toBe(false);
  expect(
    legacyCredentialRecoveryAvailable({
      kind: "ready",
      accounts: [],
      oauthBusy: false,
    }),
  ).toBe(false);

  expect(LEGACY_CREDENTIAL_RECOVERY_BUTTON_LABEL).toBe(
    "Clear old Google authorization",
  );
  expect(LEGACY_CREDENTIAL_RECOVERY_CONFIRMATION).toContain(
    "Your local calendar data remains",
  );
});
