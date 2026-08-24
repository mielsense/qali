// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type {
  SettingsSnapshot,
  SettingsWriteResult,
} from "@qali/desktop-contracts";

import {
  buildLegacySettingsMigration,
  createRendererDefaultSettings,
  deriveReduceTransparency,
  legacyRemovalKeys,
  reconcileSettingsSnapshot,
} from "./settings";

function snapshot(revision: number): SettingsSnapshot {
  return {
    settings: {
      schemaVersion: 2,
      revision,
      calendar: {
        dayStartHour: 0,
        dayEndHour: 24,
        hourHeight: 120,
        defaultView: "week",
        primaryTimeZone: "Europe/Paris",
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
    },
  };
}

describe("renderer settings reconciliation", () => {
  test("accepts a newer committed revision and ignores stale delivery", () => {
    expect(
      reconcileSettingsSnapshot(snapshot(2), snapshot(4)).settings.revision,
    ).toBe(4);
    expect(
      reconcileSettingsSnapshot(snapshot(4), snapshot(2)).settings.revision,
    ).toBe(4);
  });

  test("system reduction and durable always-reduce each independently disable transparency", () => {
    expect(deriveReduceTransparency(false, "always-reduce")).toBe(true);
    expect(deriveReduceTransparency(true, "follow-system")).toBe(true);
    expect(deriveReduceTransparency(false, "follow-system")).toBe(false);
  });

  test("enables interface sounds in the hosted renderer defaults", () => {
    expect(
      createRendererDefaultSettings("Europe/Paris").settings.appearance
        .interfaceSounds,
    ).toBe(true);
  });
});

describe("legacy settings migration", () => {
  test("strictly parses supported legacy keys into one restart-stable request", () => {
    const values = new Map([
      [
        "qali.calendar.preferences.v1",
        JSON.stringify({
          dayStartHour: 6,
          dayEndHour: 22,
          hourHeight: 80,
          defaultView: "day",
        }),
      ],
      ["vite-ui-theme", "dark"],
    ]);
    const read = (key: string) => values.get(key) ?? null;

    const first = buildLegacySettingsMigration(read);
    const afterRestart = buildLegacySettingsMigration(read);

    expect(first).toEqual(afterRestart);
    expect(first?.request).toEqual({
      operationId: "legacy-settings-v1:6:22:80:day:dark",
      calendarPreferencesV1: {
        dayStartHour: 6,
        dayEndHour: 22,
        hourHeight: 80,
        defaultView: "day",
      },
      theme: "dark",
    });
  });

  test("ignores malformed or unsupported values instead of coercing them", () => {
    const values = new Map([
      [
        "qali.calendar.preferences.v1",
        JSON.stringify({
          dayStartHour: 6,
          dayEndHour: 22,
          hourHeight: 70,
          defaultView: "day",
        }),
      ],
      ["vite-ui-theme", "sepia"],
    ]);

    expect(
      buildLegacySettingsMigration((key) => values.get(key) ?? null),
    ).toBeNull();
  });

  test("removes only submitted keys after a durable committed or replayed receipt", () => {
    const migration = buildLegacySettingsMigration((key) =>
      key === "qali.calendar.preferences.v1"
        ? JSON.stringify({
            dayStartHour: 6,
            dayEndHour: 22,
            hourHeight: 64,
            defaultView: "week",
          })
        : null,
    )!;
    const committed: SettingsWriteResult = {
      kind: "committed",
      snapshot: snapshot(4),
    };
    const replayed: SettingsWriteResult = {
      kind: "replayed",
      snapshot: snapshot(4),
    };
    const conflict: SettingsWriteResult = {
      kind: "revision-conflict",
      snapshot: snapshot(4),
    };

    expect(legacyRemovalKeys({ migration, result: committed })).toEqual([
      "qali.calendar.preferences.v1",
    ]);
    expect(legacyRemovalKeys({ migration, result: replayed })).toEqual([
      "qali.calendar.preferences.v1",
    ]);
    expect(legacyRemovalKeys({ migration, result: conflict })).toEqual([]);
  });
});
