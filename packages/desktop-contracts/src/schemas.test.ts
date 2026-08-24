import { describe, expect, test } from "bun:test";

import {
  defaultCommandKeybindings,
  desktopBootstrapSchema,
  desktopStatusEventSchema,
  parseIpcRequest,
  parseIpcResult,
  qaliSettingsDocumentSchema,
} from "./schemas";

const LOGIN_ATTEMPT = `login_${"a".repeat(32)}`;
const ASSISTANT_ATTEMPT = `assistant_${"b".repeat(32)}`;
const OPERATION_ID = "settings_00000000000000000000000000000001";
const GOOGLE_ACCOUNT_A = `gacc_${"a".repeat(43)}`;
const GOOGLE_ACCOUNT_B = `gacc_${"b".repeat(43)}`;

const validSettings = {
  schemaVersion: 2,
  revision: 0,
  calendar: {
    dayStartHour: 0,
    dayEndHour: 24,
    hourHeight: 120,
    defaultView: "week",
    primaryTimeZone: "Europe/Paris",
    secondaryTimeZones: ["America/New_York"],
    defaultCalendarId: null,
  },
  appearance: {
    theme: "system",
    glassOpacity: 0.78,
    transparency: "follow-system",
    interfaceSounds: true,
  },
  keybindings: {
    overrides: {
      "assistant.toggle": { key: "k", modifiers: ["meta"] },
    },
  },
} as const;

const validSnapshot = { settings: validSettings } as const;

describe("settings and semantic command contracts", () => {
  test("accepts the versioned document and rejects invalid settings values", () => {
    expect(qaliSettingsDocumentSchema.safeParse(validSettings).success).toBe(
      true,
    );
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        schemaVersion: 3,
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        calendar: { ...validSettings.calendar, dayStartHour: 24 },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        calendar: { ...validSettings.calendar, dayEndHour: 24.5 },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        appearance: { ...validSettings.appearance, glassOpacity: 0.59 },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        calendar: { ...validSettings.calendar, hourHeight: 95 },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        appearance: { ...validSettings.appearance, glassOpacity: 0.96 },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        appearance: { ...validSettings.appearance, interfaceSounds: "yes" },
      }).success,
    ).toBe(false);
  });

  test("defaults interface sounds on for settings written before the preference existed", () => {
    const { interfaceSounds: _missing, ...legacyAppearance } =
      validSettings.appearance;
    expect(
      qaliSettingsDocumentSchema.parse({
        ...validSettings,
        appearance: legacyAppearance,
      }).appearance.interfaceSounds,
    ).toBe(true);
  });

  test("migrates old settings to a follow-primary creation target", () => {
    const { defaultCalendarId: _missing, ...legacyCalendar } =
      validSettings.calendar;
    expect(
      qaliSettingsDocumentSchema.parse({
        ...validSettings,
        calendar: legacyCalendar,
      }).calendar.defaultCalendarId,
    ).toBeNull();
    expect(
      qaliSettingsDocumentSchema.parse({
        ...validSettings,
        calendar: {
          ...validSettings.calendar,
          defaultCalendarId: "team@example.com",
        },
      }).calendar.defaultCalendarId,
    ).toBe("team@example.com");
  });

  test("publishes the required default semantic command shortcuts", () => {
    expect(defaultCommandKeybindings).toEqual({
      "calendar.view.day": { key: "d", modifiers: [] },
      "calendar.view.week": { key: "w", modifiers: [] },
      "calendar.view.month": { key: "m", modifiers: [] },
      "calendar.today": { key: "t", modifiers: [] },
      "command-palette.open": { key: "k", modifiers: ["meta"] },
      "assistant.toggle": { key: "k", modifiers: ["meta", "shift"] },
      "calendar.event.create": { key: "n", modifiers: ["meta"] },
      "settings.open": { key: ",", modifiers: ["meta"] },
      "workspace.section.1": { key: "1", modifiers: ["meta"] },
      "workspace.section.2": { key: "2", modifiers: ["meta"] },
      "workspace.section.3": { key: "3", modifiers: ["meta"] },
      "workspace.section.4": { key: "4", modifiers: ["meta"] },
      "workspace.section.5": { key: "5", modifiers: ["meta"] },
      "workspace.section.6": { key: "6", modifiers: ["meta"] },
      "workspace.section.7": { key: "7", modifiers: ["meta"] },
      "workspace.section.8": { key: "8", modifiers: ["meta"] },
      "workspace.section.9": { key: "9", modifiers: ["meta"] },
      "calendar.navigate.previous": { key: "arrowleft", modifiers: ["meta"] },
      "calendar.navigate.next": { key: "arrowright", modifiers: ["meta"] },
    });
  });

  test("requires unique secondary time zones that differ from the primary zone", () => {
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        calendar: {
          ...validSettings.calendar,
          secondaryTimeZones: ["Europe/Paris", "Europe/Paris"],
        },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        calendar: {
          ...validSettings.calendar,
          secondaryTimeZones: ["America/New_York", "Asia/Tokyo", "UTC"],
        },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        calendar: {
          ...validSettings.calendar,
          secondaryTimeZones: ["Europe/Paris"],
        },
      }).success,
    ).toBe(false);
  });

  test("accepts only known commands with normalized non-reserved bindings", () => {
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        keybindings: { overrides: { "unknown.command": null } },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        keybindings: {
          overrides: { "assistant.toggle": { key: "K", modifiers: ["meta"] } },
        },
      }).success,
    ).toBe(false);
    expect(
      qaliSettingsDocumentSchema.safeParse({
        ...validSettings,
        keybindings: {
          overrides: { "assistant.toggle": { key: "q", modifiers: ["meta"] } },
        },
      }).success,
    ).toBe(false);
  });

  test("keeps settings IPC requests, results, and events strict", () => {
    expect(parseIpcRequest("settings:get", {})).toEqual({});
    expect(() =>
      parseIpcRequest("settings:patch", {
        baseRevision: 0,
        operationId: OPERATION_ID,
        changes: {},
        extra: true,
      }),
    ).toThrow();
    expect(
      parseIpcRequest("settings:patch", {
        baseRevision: 0,
        operationId: OPERATION_ID,
        changes: { appearance: { interfaceSounds: false } },
      }),
    ).toEqual({
      baseRevision: 0,
      operationId: OPERATION_ID,
      changes: { appearance: { interfaceSounds: false } },
    });
    expect(
      parseIpcRequest("settings:reset", {
        baseRevision: 0,
        operationId: OPERATION_ID,
        target: "appearance.interfaceSounds",
      }),
    ).toEqual({
      baseRevision: 0,
      operationId: OPERATION_ID,
      target: "appearance.interfaceSounds",
    });
    expect(
      parseIpcResult("settings:patch", {
        kind: "committed",
        snapshot: validSnapshot,
      }),
    ).toEqual({ kind: "committed", snapshot: validSnapshot });
    expect(() =>
      parseIpcResult("settings:patch", {
        kind: "committed",
        snapshot: validSnapshot,
        receipt: { operationId: OPERATION_ID },
      }),
    ).toThrow();
    expect(
      desktopStatusEventSchema.parse({
        type: "settings-changed",
        snapshot: validSnapshot,
      }),
    ).toEqual({ type: "settings-changed", snapshot: validSnapshot });
    expect(() =>
      desktopStatusEventSchema.parse({
        type: "settings-changed",
        snapshot: validSnapshot,
        internal: { operationReceipts: [] },
      }),
    ).toThrow();
  });

  test("adds the initial settings snapshot to the desktop bootstrap", () => {
    expect(
      desktopBootstrapSchema.parse({
        bridgeVersion: 2,
        convexUrl: "https://example.convex.cloud",
        rendererAuthToken: "renderer-token",
        google: { kind: "ready", accounts: [], oauthBusy: false },
        assistant: { kind: "ready" },
        settings: validSnapshot,
      }).settings,
    ).toEqual(validSnapshot);
  });

  test("keeps the bounded multi-account Google snapshot strict and secret-free", () => {
    expect(
      parseIpcResult("google:status", {
        kind: "ready",
        oauthBusy: false,
        accounts: [
          {
            accountId: GOOGLE_ACCOUNT_A,
            accountEmail: "first@example.com",
            state: "connected",
            syncState: "idle",
          },
          {
            accountId: GOOGLE_ACCOUNT_B,
            accountEmail: "second@example.com",
            state: "reconnect-required",
            reason: "authentication-expired",
          },
        ],
      }),
    ).toMatchObject({ kind: "ready", oauthBusy: false });
    expect(() =>
      parseIpcResult("google:status", {
        kind: "ready",
        oauthBusy: false,
        accounts: [
          {
            accountId: "google-account-1",
            accountEmail: "first@example.com",
            state: "connected",
            syncState: "idle",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseIpcResult("google:status", {
        kind: "ready",
        oauthBusy: false,
        accounts: Array.from({ length: 9 }, (_, index) => ({
          accountId: `gacc_${String(index).padStart(43, "0")}`,
          accountEmail: `person-${index}@example.com`,
          state: "connected",
          syncState: "idle",
        })),
      }),
    ).toThrow();
    expect(() =>
      parseIpcResult("google:status", {
        kind: "ready",
        oauthBusy: false,
        accounts: [
          {
            accountId: GOOGLE_ACCOUNT_A,
            accountEmail: "first@example.com",
            state: "connected",
            syncState: "idle",
            refreshToken: "must-not-cross",
          },
        ],
      }),
    ).toThrow();

    const legacyRecovery = {
      kind: "unavailable",
      message: "An old Google authorization needs to be cleared.",
      recoveryRequired: "legacy-credentials",
      recoveryAction: "clear-legacy-credentials",
    } as const;
    expect(parseIpcResult("google:status", legacyRecovery)).toEqual(
      legacyRecovery,
    );
    expect(() =>
      parseIpcResult("google:status", {
        kind: "unavailable",
        recoveryRequired: "legacy-credentials",
      }),
    ).toThrow();
    expect(() =>
      parseIpcResult("google:status", {
        kind: "ready",
        accounts: [],
        oauthBusy: false,
        recoveryRequired: "legacy-credentials",
        recoveryAction: "clear-legacy-credentials",
      }),
    ).toThrow();
  });
});

describe("desktop bridge request contracts", () => {
  test("rejects authority-bearing renderer fields", () => {
    expect(() =>
      parseIpcRequest("google:add-account", { executable: "/bin/sh" }),
    ).toThrow();
    expect(() =>
      parseIpcRequest("assistant:send", {
        text: "Move lunch",
        timeZone: "Europe/Paris",
        workingDirectory: "/Users/honey",
      }),
    ).toThrow();
  });

  test("exposes only account-scoped Google mutations and returns authoritative snapshots", () => {
    expect(parseIpcRequest("google:add-account", {})).toEqual({});
    expect(
      parseIpcRequest("google:reconnect-account", {
        accountId: GOOGLE_ACCOUNT_A,
      }),
    ).toEqual({ accountId: GOOGLE_ACCOUNT_A });
    expect(
      parseIpcRequest("google:disconnect-account", {
        accountId: GOOGLE_ACCOUNT_A,
      }),
    ).toEqual({ accountId: GOOGLE_ACCOUNT_A });
    expect(
      parseIpcRequest("google:sync-account", { accountId: GOOGLE_ACCOUNT_A }),
    ).toEqual({
      accountId: GOOGLE_ACCOUNT_A,
    });
    expect(parseIpcRequest("google:sync-all", {})).toEqual({});
    expect(parseIpcRequest("google:clear-legacy-credentials", {})).toEqual({});
    expect(() =>
      parseIpcRequest("google:clear-legacy-credentials", {
        accountId: GOOGLE_ACCOUNT_A,
      }),
    ).toThrow();
    expect(() =>
      parseIpcRequest("google:disconnect-account", {
        accountId: GOOGLE_ACCOUNT_A,
        revokeAll: true,
      }),
    ).toThrow();

    const snapshot = { kind: "ready", accounts: [], oauthBusy: false } as const;
    expect(
      parseIpcResult("google:add-account", {
        kind: "cancelled",
        snapshot,
      }),
    ).toEqual({ kind: "cancelled", snapshot });
    expect(
      parseIpcResult("google:add-account", {
        kind: "limit-reached",
        snapshot,
      }),
    ).toEqual({ kind: "limit-reached", snapshot });
    expect(
      parseIpcResult("google:reconnect-account", {
        kind: "completed",
        snapshot,
      }),
    ).toEqual({ kind: "completed", snapshot });
    expect(parseIpcResult("google:disconnect-account", snapshot)).toEqual(
      snapshot,
    );
    expect(parseIpcResult("google:sync-account", snapshot)).toEqual(snapshot);
    expect(parseIpcResult("google:sync-all", snapshot)).toEqual(snapshot);
    expect(parseIpcResult("google:clear-legacy-credentials", snapshot)).toEqual(
      snapshot,
    );
  });

  test("bounds assistant input", () => {
    expect(() =>
      parseIpcRequest("assistant:send", {
        text: "x".repeat(20_001),
        timeZone: "Europe/Paris",
      }),
    ).toThrow();
  });

  test("keeps updater status and install authority inside the desktop process", () => {
    expect(
      parseIpcResult("updates:status", {
        kind: "ready",
        currentVersion: "0.1.0",
        version: "0.2.0",
      }),
    ).toEqual({
      kind: "ready",
      currentVersion: "0.1.0",
      version: "0.2.0",
    });
    expect(
      desktopStatusEventSchema.parse({
        type: "update-status",
        status: {
          kind: "downloading",
          currentVersion: "0.1.0",
          version: "0.2.0",
          percent: 63.5,
        },
      }),
    ).toMatchObject({ type: "update-status" });

    for (const leakedStatus of [
      {
        kind: "ready",
        currentVersion: "0.1.0",
        version: "0.2.0",
        feedUrl: "https://updates.example.test/latest-mac.yml",
      },
      {
        kind: "ready",
        currentVersion: "0.1.0",
        version: "0.2.0",
        downloadedFile: "/private/tmp/Qali.zip",
      },
      {
        kind: "downloading",
        currentVersion: "0.1.0",
        version: "0.2.0",
        percent: 101,
      },
    ]) {
      expect(() => parseIpcResult("updates:status", leakedStatus)).toThrow();
    }

    expect(parseIpcRequest("updates:check", {})).toEqual({});
    expect(parseIpcRequest("updates:install", {})).toEqual({});
    expect(() =>
      parseIpcRequest("updates:install", { installerPath: "/tmp/Qali.zip" }),
    ).toThrow();
    expect(parseIpcResult("updates:install", { kind: "restarting" })).toEqual({
      kind: "restarting",
    });
    expect(() =>
      parseIpcResult("updates:install", {
        kind: "restarting",
        installerHandle: "private-authority",
      }),
    ).toThrow();
  });

  test("keeps readiness, execution failures, and installation selection typed", () => {
    for (const kind of [
      "probing",
      "ready",
      "ready-degraded",
      "authentication-required",
      "needs-reprobe",
      "incompatible",
      "unavailable",
      "probe-failed",
    ]) {
      expect(parseIpcResult("assistant:status", { kind })).toEqual({ kind });
    }
    expect(() =>
      parseIpcResult("assistant:status", { kind: "offline" }),
    ).toThrow();
    for (const reason of [
      "busy",
      "quota-exceeded",
      "model-unavailable",
      "entitlement-required",
    ] as const) {
      expect(
        parseIpcResult("assistant:send", { kind: "rejected", reason }),
      ).toEqual({
        kind: "rejected",
        reason,
      });
    }
    expect(parseIpcRequest("assistant:choose-codex-installation", {})).toEqual(
      {},
    );
    expect(
      parseIpcResult("assistant:choose-codex-installation", {
        kind: "selected",
        status: { kind: "ready-degraded" },
      }),
    ).toEqual({ kind: "selected", status: { kind: "ready-degraded" } });
    expect(
      parseIpcResult("assistant:choose-codex-installation", {
        kind: "cancelled",
      }),
    ).toEqual({ kind: "cancelled" });
    expect(
      parseIpcResult("assistant:choose-codex-installation", {
        kind: "missing",
      }),
    ).toEqual({ kind: "missing" });
    expect(() =>
      parseIpcResult("assistant:choose-codex-installation", {
        kind: "selected",
        status: { kind: "ready" },
        path: "/Users/me/codex",
      }),
    ).toThrow();
  });

  test("recovery exposes named intentions without renderer filesystem authority", () => {
    const backupId = "20260819T100000000Z-aaaaaaaaaaaa";
    expect(parseIpcRequest("recovery:export", {})).toEqual({});
    expect(parseIpcRequest("recovery:list-backups", {})).toEqual({});
    expect(parseIpcRequest("recovery:restore", { backupId })).toEqual({
      backupId,
    });
    expect(parseIpcRequest("recovery:reset", {})).toEqual({});
    for (const [channel, request] of [
      ["recovery:export", { destination: "/tmp/qali.json" }],
      ["recovery:list-backups", { root: "/Users/honey" }],
      ["recovery:restore", { backupId: "../escape" }],
      ["recovery:reset", { root: "/" }],
    ] as const) {
      expect(() => parseIpcRequest(channel, request)).toThrow();
    }

    expect(
      parseIpcResult("recovery:export", {
        kind: "exported",
        bytes: 42,
        calendarCount: 1,
        eventCount: 2,
      }),
    ).toMatchObject({ kind: "exported", bytes: 42 });
    expect(() =>
      parseIpcResult("recovery:export", {
        kind: "exported",
        path: "/Users/honey/Documents/qali-calendar.json",
        bytes: 42,
        calendarCount: 1,
        eventCount: 2,
      }),
    ).toThrow();
    expect(
      parseIpcResult("recovery:list-backups", [
        {
          id: backupId,
          createdAt: "2026-08-19T10:00:00.000Z",
          bytes: 120,
          buildMarker: "desktop-schema-v1",
          verified: true,
        },
      ]),
    ).toHaveLength(1);
    expect(
      parseIpcResult("recovery:restore", {
        kind: "restored",
        backupId,
        restartRequired: true,
      }),
    ).toEqual({ kind: "restored", backupId, restartRequired: true });
    expect(
      parseIpcResult("recovery:reset", {
        kind: "reset",
        restartRequired: true,
      }),
    ).toEqual({ kind: "reset", restartRequired: true });
  });

  test("strictly bounds login results, challenges, and trusted open requests", () => {
    expect(
      parseIpcResult("assistant:login", {
        kind: "started",
        attemptId: LOGIN_ATTEMPT,
      }),
    ).toEqual({ kind: "started", attemptId: LOGIN_ATTEMPT });
    expect(() =>
      parseIpcResult("assistant:login", {
        kind: "started",
        attemptId: LOGIN_ATTEMPT,
        authority: "secret",
      }),
    ).toThrow();
    expect(() =>
      desktopStatusEventSchema.parse({
        type: "assistant-login",
        attemptId: LOGIN_ATTEMPT,
        event: {
          kind: "challenge",
          url: "https://auth.openai.com.evil.test/device",
          code: "ABCD-EFGH",
        },
      }),
    ).toThrow();
    expect(
      parseIpcRequest("assistant:open-login-url", {
        attemptId: LOGIN_ATTEMPT,
        url: "https://auth.openai.com/device",
        code: "ABCD-EFGH",
      }),
    ).toEqual({
      attemptId: LOGIN_ATTEMPT,
      url: "https://auth.openai.com/device",
      code: "ABCD-EFGH",
    });
    for (const request of [
      { url: "https://auth.openai.com/device" },
      {
        attemptId: LOGIN_ATTEMPT,
        url: "javascript:alert(1)",
        code: "ABCD-EFGH",
      },
      {
        attemptId: LOGIN_ATTEMPT,
        url: "https://auth.openai.com/device",
        code: "ABCD-EFGH",
        authority: "secret",
      },
    ]) {
      expect(() =>
        parseIpcRequest("assistant:open-login-url", request),
      ).toThrow();
    }
    for (const attemptId of [
      "login_short",
      `login_${"g".repeat(32)}`,
      ASSISTANT_ATTEMPT,
    ]) {
      expect(() =>
        parseIpcResult("assistant:login", {
          kind: "started",
          attemptId,
        }),
      ).toThrow();
    }
    expect(
      parseIpcResult("assistant:send", {
        kind: "accepted",
        attemptId: ASSISTANT_ATTEMPT,
      }),
    ).toEqual({ kind: "accepted", attemptId: ASSISTANT_ATTEMPT });
    expect(() =>
      parseIpcResult("assistant:send", {
        kind: "accepted",
        attemptId: LOGIN_ATTEMPT,
      }),
    ).toThrow();
    expect(
      parseIpcRequest("assistant:cancel", {
        attemptId: LOGIN_ATTEMPT,
      }),
    ).toEqual({ attemptId: LOGIN_ATTEMPT });
    expect(
      parseIpcRequest("assistant:cancel", {
        attemptId: ASSISTANT_ATTEMPT,
      }),
    ).toEqual({ attemptId: ASSISTANT_ATTEMPT });
    expect(() =>
      parseIpcRequest("assistant:cancel", {
        attemptId: "login_forged",
      }),
    ).toThrow();
  });
});
