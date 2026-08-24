// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type { SettingsSnapshot } from "@qali/desktop-contracts";

import { commitSettingsPatch } from "./settings-patch";

function snapshot(revision: number, interfaceSounds: boolean): SettingsSnapshot {
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
        interfaceSounds,
      },
      keybindings: { overrides: {} },
    },
  };
}

describe("settings patch sound authority", () => {
  test("resyncs the gate after every authoritative conflict snapshot", async () => {
    const sounds: boolean[] = [];
    const accepted: SettingsSnapshot[] = [];
    const conflicts = [snapshot(2, true), snapshot(3, true)];

    const result = await commitSettingsPatch({
      current: snapshot(1, true),
      changes: { appearance: { interfaceSounds: false } },
      operationId: "double-conflict",
      patchRemote: async () => ({
        kind: "revision-conflict",
        snapshot: conflicts.shift()!,
      }),
      acceptSnapshot: (next) => {
        accepted.push(next);
        return next;
      },
      latestSnapshot: () => accepted.at(-1),
      setInterfaceSounds: (enabled) => sounds.push(enabled),
    });

    expect(result).toMatchObject({
      kind: "revision-conflict",
      snapshot: { settings: { revision: 3 } },
    });
    expect(sounds).toEqual([false, true, true]);
  });

  test("uses the newest accepted snapshot when delivery overlaps a write", async () => {
    const sounds: boolean[] = [];
    const newest = snapshot(3, false);

    await commitSettingsPatch({
      current: snapshot(1, true),
      changes: { appearance: { interfaceSounds: false } },
      operationId: "overlap",
      patchRemote: async () => ({
        kind: "committed",
        snapshot: snapshot(2, true),
      }),
      acceptSnapshot: () => newest,
      latestSnapshot: () => newest,
      setInterfaceSounds: (enabled) => sounds.push(enabled),
    });

    expect(sounds).toEqual([false, false]);
  });

  test("restores the latest delivered snapshot when a write fails", async () => {
    const sounds: boolean[] = [];
    let latest = snapshot(1, true);

    await expect(
      commitSettingsPatch({
        current: snapshot(1, true),
        changes: { appearance: { interfaceSounds: false } },
        operationId: "failed-write",
        patchRemote: async () => {
          latest = snapshot(2, false);
          throw new Error("disk failed");
        },
        acceptSnapshot: (next) => next,
        latestSnapshot: () => latest,
        setInterfaceSounds: (enabled) => sounds.push(enabled),
      }),
    ).rejects.toThrow("disk failed");
    expect(sounds).toEqual([false, false]);
  });
});
