import { expect, mock, test } from "bun:test";

import { createPreloadReadiness } from "../src/preload/readiness";

test("holds bootstrap IPC until main has registered the renderer document", async () => {
  const readiness = createPreloadReadiness();
  let calls = 0;
  const bootstrap = readiness.run(() => {
    calls += 1;
    return "bootstrapped";
  });

  await Promise.resolve();
  expect(calls).toBe(0);

  readiness.markReady();
  await expect(bootstrap).resolves.toBe("bootstrapped");
  expect(calls).toBe(1);
});

test("settings preload methods wait for readiness and status subscriptions unsubscribe", async () => {
  const invokes: unknown[][] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let ready!: () => void;
  let exposed: any;
  mock.module("electron", () => ({
    contextBridge: {
      exposeInMainWorld(_name: string, value: unknown) {
        exposed = value;
      },
    },
    ipcRenderer: {
      invoke: async (channel: string, payload: unknown) => {
        invokes.push([channel, payload]);
        const googleSnapshot = {
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        };
        if (
          channel === "google:status" ||
          channel === "google:disconnect-account" ||
          channel === "google:sync-account" ||
          channel === "google:sync-all" ||
          channel === "google:clear-legacy-credentials"
        ) {
          return googleSnapshot;
        }
        if (
          channel === "google:add-account" ||
          channel === "google:reconnect-account"
        ) {
          return { kind: "completed", snapshot: googleSnapshot };
        }
        if (channel === "settings:get")
          return { settings: settingsSnapshot(2) };
        return {
          kind: "committed",
          snapshot: { settings: settingsSnapshot(3) },
        };
      },
      once(channel: string, listener: () => void) {
        expect(channel).toBe("desktop:ready");
        ready = listener;
      },
      on(channel: string, listener: (...args: unknown[]) => void) {
        listeners.set(channel, listener);
      },
      removeListener(channel: string, listener: (...args: unknown[]) => void) {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
      send() {},
    },
  }));
  const previousDocument = globalThis.document;
  Object.assign(globalThis, {
    document: { addEventListener() {} },
  });
  try {
    await import(`../src/preload/index.ts?settings=${crypto.randomUUID()}`);
    const pending = exposed.settings.get();
    await Promise.resolve();
    expect(invokes).toEqual([]);
    ready();
    await expect(pending).resolves.toEqual({ settings: settingsSnapshot(2) });
    await exposed.settings.patch({
      baseRevision: 2,
      operationId: "patch-1",
      changes: { appearance: { theme: "dark" } },
    });
    await exposed.settings.reset({
      baseRevision: 3,
      operationId: "reset-1",
      target: "appearance",
    });
    await exposed.settings.importLegacy({
      operationId: "legacy-1",
      theme: "dark",
    });
    const accountId = `gacc_${"a".repeat(43)}`;
    await exposed.google.status();
    await exposed.google.addAccount();
    await exposed.google.reconnectAccount(accountId);
    await exposed.google.disconnectAccount(accountId);
    await exposed.google.syncAccount(accountId);
    await exposed.google.syncAll();
    await exposed.google.clearLegacyCredentials();
    expect(invokes).toEqual([
      ["settings:get", {}],
      [
        "settings:patch",
        {
          baseRevision: 2,
          operationId: "patch-1",
          changes: { appearance: { theme: "dark" } },
        },
      ],
      [
        "settings:reset",
        {
          baseRevision: 3,
          operationId: "reset-1",
          target: "appearance",
        },
      ],
      ["settings:import-legacy", { operationId: "legacy-1", theme: "dark" }],
      ["google:status", {}],
      ["google:add-account", {}],
      ["google:reconnect-account", { accountId }],
      ["google:disconnect-account", { accountId }],
      ["google:sync-account", { accountId }],
      ["google:sync-all", {}],
      ["google:clear-legacy-credentials", {}],
    ]);
    expect(invokes.map(([channel]) => channel)).toEqual([
      "settings:get",
      "settings:patch",
      "settings:reset",
      "settings:import-legacy",
      "google:status",
      "google:add-account",
      "google:reconnect-account",
      "google:disconnect-account",
      "google:sync-account",
      "google:sync-all",
      "google:clear-legacy-credentials",
    ]);

    const events: unknown[] = [];
    const unsubscribe = exposed.events.subscribe((event: unknown) =>
      events.push(event),
    );
    listeners.get("desktop:status")?.(
      {},
      {
        type: "settings-changed",
        snapshot: { settings: settingsSnapshot(4) },
      },
    );
    expect(events).toEqual([
      {
        type: "settings-changed",
        snapshot: { settings: settingsSnapshot(4) },
      },
    ]);
    expect(() =>
      listeners.get("desktop:status")?.(
        {},
        {
          type: "settings-changed",
          snapshot: { settings: { revision: 5 } },
        },
      ),
    ).toThrow();
    expect(events).toHaveLength(1);
    unsubscribe();
    expect(listeners.has("desktop:status")).toBe(false);
  } finally {
    Object.assign(globalThis, { document: previousDocument });
  }
});

function settingsSnapshot(revision: number) {
  return {
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
  };
}
