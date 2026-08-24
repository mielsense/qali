import { describe, expect, test } from "bun:test";

import {
  createDefaultSettings,
  mergeSettingsChanges,
  parseSettingsDocument,
} from "../src/main/settings/schema";
import { canonicalizeTimeZone } from "../src/main/settings/time-zones";

describe("settings schema", () => {
  test("creates the exact schema-v2 defaults with a canonical system zone", () => {
    expect(createDefaultSettings("US/Eastern")).toEqual({
      schemaVersion: 2,
      revision: 0,
      calendar: {
        dayStartHour: 0,
        dayEndHour: 24,
        hourHeight: 120,
        defaultView: "week",
        primaryTimeZone: "America/New_York",
        secondaryTimeZones: [],
        defaultCalendarId: null,
      },
      appearance: {
        theme: "system",
        glassOpacity: 0.78,
        transparency: "follow-system",
        interfaceSounds: true,
      },
      keybindings: { overrides: {} },
    });
  });

  test("migrates older schema-v2 appearance settings and merges the sound preference", () => {
    const defaults = createDefaultSettings("Europe/Paris");
    const { interfaceSounds: _missing, ...legacyAppearance } =
      defaults.appearance;

    expect(
      parseSettingsDocument({
        ...defaults,
        appearance: legacyAppearance,
      }).appearance.interfaceSounds,
    ).toBe(true);
    expect(
      mergeSettingsChanges(defaults, {
        appearance: { interfaceSounds: false },
      }).appearance.interfaceSounds,
    ).toBe(false);
  });

  test("canonicalizes aliases before enforcing primary and secondary uniqueness", () => {
    expect(canonicalizeTimeZone("US/Pacific")).toBe("America/Los_Angeles");

    const defaults = createDefaultSettings("Europe/Paris");
    expect(() =>
      mergeSettingsChanges(defaults, {
        calendar: {
          primaryTimeZone: "US/Eastern",
          secondaryTimeZones: ["America/New_York"],
        },
      }),
    ).toThrow("cannot match the primary time zone");
  });

  test("rejects non-v2, out-of-range, non-integral, and unknown settings fields", () => {
    const defaults = createDefaultSettings("Europe/Paris");

    for (const invalid of [
      { ...defaults, schemaVersion: 3 },
      { ...defaults, calendar: { ...defaults.calendar, dayStartHour: 2.5 } },
      {
        ...defaults,
        appearance: { ...defaults.appearance, glassOpacity: 0.59 },
      },
      { ...defaults, google: { accountId: "not-settings-data" } },
    ]) {
      expect(() => parseSettingsDocument(invalid)).toThrow();
    }
  });
});
