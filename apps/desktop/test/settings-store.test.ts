import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSettingsStore } from "../src/main/settings/store";

const roots: string[] = [];

async function makeConfigRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qali-settings-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("main-owned settings store", () => {
  test("persists defaults privately and captures the canonical system zone only once", async () => {
    const configRoot = await makeConfigRoot();
    const first = await openSettingsStore({
      configRoot,
      systemTimeZone: "US/Eastern",
    });

    expect(first.snapshot()).toEqual({
      settings: expect.objectContaining({
        schemaVersion: 2,
        revision: 0,
        calendar: expect.objectContaining({
          dayStartHour: 0,
          dayEndHour: 24,
          hourHeight: 120,
          defaultView: "week",
          primaryTimeZone: "America/New_York",
          secondaryTimeZones: [],
          defaultCalendarId: null,
        }),
        appearance: {
          theme: "system",
          glassOpacity: 0.78,
          transparency: "follow-system",
          interfaceSounds: true,
        },
        keybindings: { overrides: {} },
      }),
    });
    expect((await lstat(join(configRoot, "settings.json"))).mode & 0o777).toBe(
      0o600,
    );
    await first.close();

    const reopened = await openSettingsStore({
      configRoot,
      systemTimeZone: "Asia/Tokyo",
    });
    expect(reopened.snapshot().settings.calendar.primaryTimeZone).toBe(
      "America/New_York",
    );
    await reopened.close();
  });

  test("persists disabled interface sounds across restart", async () => {
    const configRoot = await makeConfigRoot();
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });

    const result = await store.patch({
      baseRevision: 0,
      operationId: "disable-interface-sounds",
      changes: { appearance: { interfaceSounds: false } },
    });
    expect(result.snapshot.settings.appearance.interfaceSounds).toBe(false);
    await store.close();

    const reopened = await openSettingsStore({
      configRoot,
      systemTimeZone: "Asia/Tokyo",
    });
    expect(reopened.snapshot().settings.appearance.interfaceSounds).toBe(false);
    await reopened.close();
  });

  test("calendar reset preserves the primary zone captured at initial creation", async () => {
    const configRoot = await makeConfigRoot();
    const created = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    await created.close();

    const reopened = await openSettingsStore({
      configRoot,
      systemTimeZone: "Asia/Tokyo",
    });
    const reset = await reopened.reset({
      baseRevision: 0,
      operationId: "reset-calendar-after-zone-change",
      target: "calendar",
    });
    expect(reset.snapshot.settings.calendar.primaryTimeZone).toBe(
      "Europe/Paris",
    );
    await reopened.close();

    const persisted = JSON.parse(
      await readFile(join(configRoot, "settings.json"), "utf8"),
    );
    expect(persisted.settings.calendar.primaryTimeZone).toBe("Europe/Paris");
  });

  test("commits merged writes, publishes once, rejects stale revisions, and replays across restart", async () => {
    const configRoot = await makeConfigRoot();
    const operationId = "patch-hour-height";
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    const published: number[] = [];
    const unsubscribe = store.subscribe((snapshot) =>
      published.push(snapshot.settings.revision),
    );

    const first = await store.patch({
      baseRevision: 0,
      operationId,
      changes: { calendar: { hourHeight: 72 } },
    });
    expect(first).toMatchObject({
      kind: "committed",
      snapshot: { settings: { revision: 1, calendar: { hourHeight: 72 } } },
    });
    expect(
      await store.patch({
        baseRevision: 0,
        operationId: "stale-write",
        changes: { appearance: { theme: "dark" } },
      }),
    ).toMatchObject({
      kind: "revision-conflict",
      snapshot: { settings: { revision: 1 } },
    });
    expect(published).toEqual([1]);
    unsubscribe();
    await store.close();

    const reopened = await openSettingsStore({
      configRoot,
      systemTimeZone: "Asia/Tokyo",
    });
    const replay = await reopened.patch({
      baseRevision: 0,
      operationId,
      changes: { calendar: { hourHeight: 72 } },
    });
    expect(replay.kind).toBe("replayed");
    expect(replay.snapshot.settings.calendar.primaryTimeZone).toBe(
      "Europe/Paris",
    );
    expect(replay.snapshot.settings.revision).toBe(1);
    await reopened.close();
  });

  test("validates the fully merged patch atomically and canonicalizes zone aliases", async () => {
    const configRoot = await makeConfigRoot();
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });

    await expect(
      store.patch({
        baseRevision: 0,
        operationId: "invalid-hours",
        changes: { calendar: { dayStartHour: 20, dayEndHour: 8 } },
      }),
    ).rejects.toThrow("dayStartHour");
    expect(store.snapshot().settings.revision).toBe(0);
    expect(store.snapshot().settings.calendar).toMatchObject({
      dayStartHour: 0,
      dayEndHour: 24,
    });

    const result = await store.patch({
      baseRevision: 0,
      operationId: "canonical-zone",
      changes: {
        calendar: {
          primaryTimeZone: "US/Pacific",
          secondaryTimeZones: ["US/Eastern"],
        },
      },
    });
    expect(result.snapshot.settings.calendar).toMatchObject({
      primaryTimeZone: "America/Los_Angeles",
      secondaryTimeZones: ["America/New_York"],
    });
    await store.close();
  });

  test("resets individual keys and sections through revisioned receipts", async () => {
    const configRoot = await makeConfigRoot();
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    await store.patch({
      baseRevision: 0,
      operationId: "customize",
      changes: {
        calendar: { hourHeight: 72 },
        appearance: { theme: "dark" },
        keybindings: {
          overrides: { "calendar.today": { key: "t", modifiers: [] } },
        },
      },
    });

    await store.reset({
      baseRevision: 1,
      operationId: "reset-density",
      target: "calendar.hourHeight",
    });
    expect(store.snapshot().settings).toMatchObject({
      revision: 2,
      calendar: { hourHeight: 120 },
      appearance: { theme: "dark" },
    });
    await store.reset({
      baseRevision: 2,
      operationId: "reset-bindings",
      target: "keybindings",
    });
    expect(store.snapshot().settings.keybindings.overrides).toEqual({});
    await store.close();
  });

  test("imports supported legacy density and theme once while preserving explicit settings", async () => {
    const configRoot = await makeConfigRoot();
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    await store.patch({
      baseRevision: 0,
      operationId: "explicit-start",
      changes: { calendar: { dayStartHour: 7 } },
    });
    const imported = await store.importLegacy({
      operationId: "legacy-import",
      calendarPreferencesV1: {
        dayStartHour: 9,
        dayEndHour: 18,
        hourHeight: 80,
        defaultView: "day",
      },
      theme: "dark",
    });
    expect(imported.snapshot.settings).toMatchObject({
      revision: 2,
      calendar: {
        dayStartHour: 7,
        dayEndHour: 18,
        hourHeight: 96,
        defaultView: "day",
      },
      appearance: { theme: "dark" },
    });

    await store.importLegacy({
      operationId: "later-legacy-import",
      calendarPreferencesV1: {
        dayStartHour: 4,
        dayEndHour: 12,
        hourHeight: 64,
        defaultView: "month",
      },
      theme: "light",
    });
    expect(store.snapshot().settings).toMatchObject({
      calendar: {
        dayStartHour: 7,
        dayEndHour: 18,
        hourHeight: 96,
        defaultView: "day",
      },
      appearance: { theme: "dark" },
    });
    await store.close();

    const persisted = JSON.parse(
      await readFile(join(configRoot, "settings.json"), "utf8"),
    );
    expect(persisted.internal.legacyImports).toEqual({
      calendarPreferencesV1: true,
      viteUiTheme: true,
    });
  });

  test("ignores unsupported legacy density instead of coercing it", async () => {
    const configRoot = await makeConfigRoot();
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    const result = await store.importLegacy({
      operationId: "unsupported-density",
      calendarPreferencesV1: {
        dayStartHour: 6,
        dayEndHour: 20,
        hourHeight: 88,
        defaultView: "month",
      },
    });
    expect(result.snapshot.settings.calendar).toMatchObject({
      dayStartHour: 6,
      dayEndHour: 20,
      hourHeight: 120,
      defaultView: "month",
    });
    await store.close();
  });

  test("quarantines corrupt and future documents before creating replacement defaults", async () => {
    for (const fixture of [
      { label: "corrupt", contents: "{ definitely-not-json" },
      {
        label: "future",
        contents: JSON.stringify({ settings: { schemaVersion: 99 } }),
      },
    ]) {
      const configRoot = await makeConfigRoot();
      await writeFile(join(configRoot, "settings.json"), fixture.contents, {
        mode: 0o600,
      });

      const store = await openSettingsStore({
        configRoot,
        systemTimeZone: "Asia/Tokyo",
      });
      expect(store.snapshot().settings).toMatchObject({
        schemaVersion: 2,
        revision: 0,
        calendar: { primaryTimeZone: "Asia/Tokyo" },
      });
      await store.close();

      const names = await readdir(configRoot);
      const quarantine = names.find((name) =>
        name.startsWith(`settings.json.quarantine-${fixture.label}-`),
      );
      expect(quarantine).toBeDefined();
      expect(await readFile(join(configRoot, quarantine!), "utf8")).toBe(
        fixture.contents,
      );
    }
  });

  test("keeps the receipt ledger bounded while retaining recent replay identities", async () => {
    const configRoot = await makeConfigRoot();
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    for (let revision = 0; revision < 132; revision += 1) {
      await store.patch({
        baseRevision: revision,
        operationId: `bounded-${revision}`,
        changes: {
          appearance: { glassOpacity: revision % 2 === 0 ? 0.78 : 0.79 },
        },
      });
    }
    await store.close();

    const persisted = JSON.parse(
      await readFile(join(configRoot, "settings.json"), "utf8"),
    );
    expect(persisted.internal.operationReceipts).toHaveLength(128);
    expect(persisted.internal.operationReceipts.at(-1).operationId).toBe(
      "bounded-131",
    );

    const reopened = await openSettingsStore({
      configRoot,
      systemTimeZone: "Asia/Tokyo",
    });
    expect(
      (
        await reopened.patch({
          baseRevision: 0,
          operationId: "bounded-131",
          changes: { appearance: { glassOpacity: 0.79 } },
        })
      ).kind,
    ).toBe("replayed");
    await reopened.close();
  });

  test("does not publish or advance memory when the durable rename fails", async () => {
    const configRoot = await makeConfigRoot();
    const settingsPath = join(configRoot, "settings.json");
    const displacedPath = join(configRoot, "settings-before-disk-error.json");
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    const published: number[] = [];
    store.subscribe((snapshot) => published.push(snapshot.settings.revision));
    await rename(settingsPath, displacedPath);
    await mkdir(settingsPath);

    await expect(
      store.patch({
        baseRevision: 0,
        operationId: "disk-error",
        changes: { appearance: { theme: "dark" } },
      }),
    ).rejects.toThrow();
    expect(store.snapshot().settings).toMatchObject({
      revision: 0,
      appearance: { theme: "system" },
    });
    expect(published).toEqual([]);

    await rm(settingsPath, { recursive: true });
    await rename(displacedPath, settingsPath);
    await chmod(settingsPath, 0o600);
    expect(
      (
        await store.patch({
          baseRevision: 0,
          operationId: "disk-error",
          changes: { appearance: { theme: "dark" } },
        })
      ).kind,
    ).toBe("committed");
    await store.close();
  });

  test("keeps a committed write successful when one subscriber throws", async () => {
    const configRoot = await makeConfigRoot();
    const store = await openSettingsStore({
      configRoot,
      systemTimeZone: "Europe/Paris",
    });
    const observed: number[] = [];
    store.subscribe(() => {
      throw new Error("broken renderer subscriber");
    });
    store.subscribe((snapshot) => observed.push(snapshot.settings.revision));

    await expect(
      store.patch({
        baseRevision: 0,
        operationId: "subscriber-isolation",
        changes: { appearance: { theme: "dark" } },
      }),
    ).resolves.toMatchObject({
      kind: "committed",
      snapshot: { settings: { revision: 1 } },
    });
    expect(observed).toEqual([1]);
    await store.close();
  });
});
