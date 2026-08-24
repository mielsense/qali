import { describe, expect, test } from "bun:test";

import {
  authorizeSender,
  createAssistantIpcHandlers,
  createCodexLoginEventForwarder,
  createCodexInstallationChooser,
  createAssistantLoginChallengeRegistry,
  createDesktopIpcHandlers,
  createGoogleSyncIpcHandlers,
  createRecoveryIpcHandlers,
  createRendererIpcRegistry,
  createSettingsIpcHandlers,
  DESKTOP_IPC_CHANNELS,
  registerDesktopIpc,
  subscribeSettingsChanges,
} from "../src/main/ipc/router";

const LOGIN_A = `login_${"a".repeat(32)}`;
const LOGIN_B = `login_${"b".repeat(32)}`;

function settingsSnapshot(revision = 0) {
  return {
    settings: {
      schemaVersion: 2 as const,
      revision,
      calendar: {
        dayStartHour: 0,
        dayEndHour: 24,
        hourHeight: 120 as const,
        defaultView: "week" as const,
        primaryTimeZone: "Europe/Paris",
        secondaryTimeZones: [],
        defaultCalendarId: null,
      },
      appearance: {
        theme: "system" as const,
        glassOpacity: 0.78,
        transparency: "follow-system" as const,
        interfaceSounds: true,
      },
      keybindings: { overrides: {} },
    },
  };
}

function fakeFrame(url: string, isSubframe: boolean) {
  return {
    frameToken: crypto.randomUUID(),
    parent: isSubframe ? {} : null,
    url,
  };
}

function fakeRenderer(
  id: number,
  frame = fakeFrame("qali-app://renderer/", false),
) {
  return { id, mainFrame: frame };
}

function fakeEvent(sender: ReturnType<typeof fakeRenderer>) {
  return { sender, senderFrame: sender.mainFrame };
}

describe("desktop IPC sender authorization", () => {
  test("rejects subframes and non-Qali origins", () => {
    expect(authorizeSender(fakeFrame("https://example.com", false))).toBe(
      false,
    );
    expect(authorizeSender(fakeFrame("qali-app://renderer/", true))).toBe(
      false,
    );
  });

  test("accepts only the Qali renderer main frame", () => {
    expect(authorizeSender(fakeFrame("qali-app://renderer/", false))).toBe(
      true,
    );
  });

  test("rejects an origin-valid window that main did not register", () => {
    const registry = createRendererIpcRegistry();
    const registered = fakeRenderer(1);
    const unregistered = fakeRenderer(2);
    registry.register(registered, ["google:status"]);

    expect(registry.authorize(fakeEvent(unregistered), "google:status")).toBe(
      false,
    );
  });

  test("rejects a stale renderer document generation", () => {
    const registry = createRendererIpcRegistry();
    const oldDocument = fakeRenderer(1);
    registry.register(oldDocument, ["google:status"]);
    registry.register(fakeRenderer(1), ["google:status"]);

    expect(registry.authorize(fakeEvent(oldDocument), "google:status")).toBe(
      false,
    );
  });

  test("rejects an IPC operation outside the renderer capability set", () => {
    const registry = createRendererIpcRegistry();
    const renderer = fakeRenderer(1);
    registry.register(renderer, ["google:status"]);

    expect(registry.authorize(fakeEvent(renderer), "assistant:send")).toBe(
      false,
    );
  });
});

/* Removed legacy single-account Google IPC tests. Account-scoped v2 behavior
 * is covered by google-ipc-v2.test.ts.
describe("legacy single-account Google sync IPC intentions", () => {
  test("connection and manual refresh wake the single main-process worker", async () => {
    const wakes: string[] = [];
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => ({ kind: "connected" }),
        disconnect: async () => {},
        status: async () => ({ kind: "connected" }),
      },
      {
        status: { kind: "idle" },
        onStatus: () => () => {},
        wake: (trigger) => wakes.push(trigger),
      },
    );

    await handlers["google:connect"](undefined, {} as any);
    await handlers["google:sync-now"](undefined, {} as any);

    expect(wakes).toEqual(["connection", "manual"]);
  });

  test("Google status exposes the worker state instead of OAuth's stale idle state", async () => {
    let publishSyncStatus!: (status: { kind: string }) => void;
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => ({ kind: "connected" }),
        disconnect: async () => {},
        status: async () => ({
          kind: "connected",
          accountEmail: "me@example.com",
          syncState: "idle",
        }),
      },
      {
        status: { kind: "idle" },
        onStatus: (listener) => {
          publishSyncStatus = listener;
          return () => {};
        },
        wake: () => {},
      },
    );
    publishSyncStatus({ kind: "offline" });

    await expect(
      handlers["google:status"](undefined, {} as any),
    ).resolves.toMatchObject({
      kind: "connected",
      syncState: "offline",
    });
  });

  test("Google status explains when the Cloud project has no Calendar API", async () => {
    let publishSyncStatus!: (status: { kind: string }) => void;
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => ({ kind: "connected" }),
        disconnect: async () => {},
        status: async () => ({
          kind: "connected",
          accountEmail: "me@example.com",
          syncState: "idle",
        }),
      },
      {
        status: { kind: "idle" },
        onStatus: (listener) => {
          publishSyncStatus = listener;
          return () => {};
        },
        wake: () => {},
      },
    );
    publishSyncStatus({ kind: "configuration-required" });

    await expect(
      handlers["google:status"](undefined, {} as any),
    ).resolves.toMatchObject({
      kind: "connected",
      syncState: "error",
      message:
        "Enable the Google Calendar API in this OAuth project's Google Cloud console.",
    });
  });

  test("releases the worker status subscription when the handler set is disposed", () => {
    let disposeCalls = 0;
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => ({ kind: "disconnected" }),
        disconnect: async () => {},
        status: async () => ({ kind: "disconnected" }),
      },
      {
        status: { kind: "idle" },
        onStatus: () => () => {
          disposeCalls += 1;
        },
        wake: () => {},
      },
    );

    void handlers.dispose();

    expect(disposeCalls).toBe(1);
  });

  test("revocation blocks new Google work and disposal joins an in-flight connection", async () => {
    let finishConnect!: () => void;
    let connected = 0;
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => {
          await new Promise<void>((resolve) => {
            finishConnect = resolve;
          });
          connected += 1;
          return { kind: "connected" };
        },
        disconnect: async () => {
          connected -= 1;
        },
        status: async () => ({ kind: "disconnected" }),
      },
      {
        status: { kind: "idle" },
        onStatus: () => () => {},
        wake: () => {},
      },
    );
    const connection = handlers["google:connect"]({}, {} as any);
    await Promise.resolve();
    handlers.revoke();
    let disposed = false;
    const disposal = handlers.dispose().then(() => {
      disposed = true;
    });

    await expect(handlers["google:disconnect"]({}, {} as any)).rejects.toThrow(
      "RECOVERY_UNAVAILABLE",
    );
    await expect(handlers["google:sync-now"]({}, {} as any)).rejects.toThrow(
      "RECOVERY_UNAVAILABLE",
    );
    expect(disposed).toBe(false);
    finishConnect();
    await expect(connection).rejects.toThrow("RECOVERY_UNAVAILABLE");
    await disposal;
    expect(connected).toBe(1);
  });

  test.each([
    [
      "cleanup-failed",
      "Calendar setup is incomplete. Retry Google connection to resume.",
    ],
    [
      "migration-failed",
      "Calendar setup could not finish. Retry Google connection to resume.",
    ],
    ["stopped", "Calendar setup stopped before sync could begin."],
    [
      "disconnected",
      "Google connection changed before calendar setup completed.",
    ],
  ] as const)("defers Google sync while provider cleanup is %s", async (
    reason,
    message,
  ) => {
    const wakes: string[] = [];
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => ({
          kind: "connected",
          accountEmail: "me@example.com",
        }),
        disconnect: async () => {},
        status: async () => ({ kind: "connected", accountEmail: "me@example.com" }),
      },
      {
        status: { kind: "idle" },
        onStatus: () => () => {},
        wake: (trigger) => wakes.push(trigger),
      },
      {
        afterConnected: async () => ({
          kind: "deferred",
          reason,
        }),
      },
    );

    await expect(handlers["google:connect"]({}, {} as any)).resolves.toEqual({
      kind: "connected",
      accountEmail: "me@example.com",
      syncState: "error",
      message,
    });
    await handlers["google:sync-now"]({}, {} as any);

    expect(wakes).toEqual([]);
  });

  test("successful Google connection resumes migration before one sync wake", async () => {
    const calls: string[] = [];
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => {
          calls.push("connected");
          return { kind: "connected" };
        },
        disconnect: async () => {},
        status: async () => ({ kind: "disconnected" }),
      },
      {
        status: { kind: "idle" },
        onStatus: () => () => {},
        wake: () => {
          calls.push("wake");
        },
      },
      {
        afterConnected: async () => {
          calls.push("migration");
          return { kind: "completed", cleared: 0 };
        },
      },
    );

    await handlers["google:connect"]({}, {} as any);
    expect(calls).toEqual(["connected", "migration", "wake"]);
  });

  test("lets the first completed migration start sync without a second connection wake", async () => {
    const calls: string[] = [];
    const handlers = createGoogleSyncIpcHandlers(
      {
        connect: async () => ({ kind: "connected" }),
        disconnect: async () => {},
        status: async () => ({ kind: "disconnected" }),
      },
      {
        status: { kind: "idle" },
        onStatus: () => () => {},
        wake: () => calls.push("wake"),
      },
      {
        afterConnected: async () => ({ kind: "completed", cleared: 1 }),
        onMigrationCompleted: () => {
          calls.push("start");
          return true;
        },
      },
    );

    await handlers["google:connect"]({}, {} as any);
    expect(calls).toEqual(["start"]);
  });
});
*/

describe("complete desktop handler map", () => {
  test("native Codex chooser validates one main-owned path without returning it", async () => {
    const selections: string[] = [];
    const chooser = createCodexInstallationChooser({
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: ["/Applications/Codex.app/Contents/MacOS/codex"],
      }),
      selection: {
        validate: async (path) => {
          selections.push(path);
          return { kind: "supported", status: { kind: "ready-degraded" } };
        },
      },
    });
    const result = await chooser();
    expect(result).toEqual({
      kind: "selected",
      status: { kind: "ready-degraded" },
    });
    expect(JSON.stringify(result)).not.toContain("/Applications");
    expect(selections).toEqual([
      "/Applications/Codex.app/Contents/MacOS/codex",
    ]);
  });

  test("native Codex chooser returns typed cancelled, missing, and incompatible results", async () => {
    const cancelled = createCodexInstallationChooser({
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      selection: {
        validate: async () => {
          throw new Error("must not validate cancellation");
        },
      },
    });
    await expect(cancelled()).resolves.toEqual({ kind: "cancelled" });
    for (const result of [
      { kind: "missing" as const },
      {
        kind: "incompatible" as const,
        status: { kind: "incompatible" as const },
      },
    ]) {
      const chooser = createCodexInstallationChooser({
        showOpenDialog: async () => ({
          canceled: false,
          filePaths: ["/selected/codex"],
        }),
        selection: { validate: async () => result },
      });
      await expect(chooser()).resolves.toEqual(
        result.kind === "missing" ? { kind: "missing" } : result,
      );
    }
  });
  test("settings handlers expose only named durable store intentions", async () => {
    const calls: unknown[] = [];
    const handlers = createSettingsIpcHandlers({
      snapshot: () => settingsSnapshot(3),
      patch: async (request) => {
        calls.push(["patch", request]);
        return { kind: "committed", snapshot: settingsSnapshot(4) };
      },
      reset: async (request) => {
        calls.push(["reset", request]);
        return { kind: "committed", snapshot: settingsSnapshot(5) };
      },
      importLegacy: async (request) => {
        calls.push(["import", request]);
        return { kind: "replayed", snapshot: settingsSnapshot(6) };
      },
    });

    expect(handlers["settings:get"]({}, {} as any)).toEqual(
      settingsSnapshot(3),
    );
    await handlers["settings:patch"](
      {
        baseRevision: 3,
        operationId: "patch-1",
        changes: { appearance: { theme: "dark" } },
      },
      {} as any,
    );
    await handlers["settings:reset"](
      { baseRevision: 4, operationId: "reset-1", target: "appearance" },
      {} as any,
    );
    await handlers["settings:import-legacy"](
      { operationId: "legacy-1", theme: "dark" },
      {} as any,
    );

    expect(calls).toEqual([
      [
        "patch",
        {
          baseRevision: 3,
          operationId: "patch-1",
          changes: { appearance: { theme: "dark" } },
        },
      ],
      [
        "reset",
        { baseRevision: 4, operationId: "reset-1", target: "appearance" },
      ],
      ["import", { operationId: "legacy-1", theme: "dark" }],
    ]);
  });

  test("publishes validated settings changes and stops after unsubscribe", () => {
    let listener:
      ((value: ReturnType<typeof settingsSnapshot>) => void) | undefined;
    const published: unknown[] = [];
    const unsubscribe = subscribeSettingsChanges(
      {
        subscribe(next) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      (event) => published.push(event),
    );

    listener!(settingsSnapshot(7));
    expect(() => listener!({ settings: { revision: 8 } } as never)).toThrow();
    unsubscribe();
    listener?.(settingsSnapshot(8));

    expect(published).toEqual([
      { type: "settings-changed", snapshot: settingsSnapshot(7) },
    ]);
  });

  test("rejects settings access from an unregistered renderer", async () => {
    const handlers = createDesktopIpcHandlers({
      bootstrap: async () => ({
        bridgeVersion: 1,
        convexUrl: "http://127.0.0.1:3310",
        rendererAuthToken: "renderer.jwt.token",
        google: { kind: "disconnected" },
        assistant: { kind: "unavailable" },
        settings: settingsSnapshot(),
      }),
      google: {
        "google:add-account": async () => ({
          kind: "cancelled",
          snapshot: { kind: "ready", accounts: [], oauthBusy: false },
        }),
        "google:clear-legacy-credentials": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:disconnect-account": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:reconnect-account": async () => ({
          kind: "cancelled",
          snapshot: { kind: "ready", accounts: [], oauthBusy: false },
        }),
        "google:status": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:sync-account": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:sync-all": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
      },
      settings: createSettingsIpcHandlers({
        snapshot: () => settingsSnapshot(),
        patch: async () => ({
          kind: "committed",
          snapshot: settingsSnapshot(1),
        }),
        reset: async () => ({
          kind: "committed",
          snapshot: settingsSnapshot(1),
        }),
        importLegacy: async () => ({
          kind: "committed",
          snapshot: settingsSnapshot(1),
        }),
      }),
    });
    const installed = new Map<
      string,
      (event: any, payload: unknown) => Promise<unknown>
    >();
    registerDesktopIpc(
      {
        handle: (channel, handler) => installed.set(channel, handler as never),
      },
      handlers,
      createRendererIpcRegistry(),
    );

    await expect(
      installed.get("settings:get")!(fakeEvent(fakeRenderer(91)), {}),
    ).rejects.toThrow("Unauthorized desktop IPC sender");
  });

  test("recovery handlers expose only named main-owned intentions", async () => {
    const calls: unknown[] = [];
    const handlers = createRecoveryIpcHandlers({
      exportData: async () => {
        calls.push("export");
        return { kind: "cancelled" };
      },
      listBackups: async () => {
        calls.push("list");
        return [];
      },
      restore: async (backupId) => {
        calls.push(["restore", backupId]);
      },
      reset: async () => {
        calls.push("reset");
      },
    });

    await handlers["recovery:export"]({}, {} as any);
    await handlers["recovery:list-backups"]({}, {} as any);
    await expect(
      handlers["recovery:restore"](
        { backupId: "20260819T100000000Z-aaaaaaaaaaaa" },
        {} as any,
      ),
    ).resolves.toEqual({
      kind: "restored",
      backupId: "20260819T100000000Z-aaaaaaaaaaaa",
      restartRequired: true,
    });
    await expect(handlers["recovery:reset"]({}, {} as any)).resolves.toEqual({
      kind: "reset",
      restartRequired: true,
    });
    expect(calls).toEqual([
      "export",
      "list",
      ["restore", "20260819T100000000Z-aaaaaaaaaaaa"],
      "reset",
    ]);
  });

  test("blocked assistant status/login/send fail synchronously without coordinator launch", async () => {
    const calls: unknown[] = [];
    const handlers = createAssistantIpcHandlers({
      send: async (request) => {
        calls.push(request);
        return { kind: "accepted" as const, attemptId: "attempt-1" };
      },
      cancel: async (attemptId) => {
        calls.push(attemptId);
      },
    });

    await expect(handlers["assistant:status"]({}, {} as any)).resolves.toEqual({
      kind: "unavailable",
    });
    await expect(handlers["assistant:login"]({}, {} as any)).resolves.toEqual({
      kind: "rejected",
      status: { kind: "unavailable" },
    });
    await expect(
      handlers["assistant:send"](
        { text: "What is next?", timeZone: "Europe/Paris" },
        {} as any,
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "unavailable" });
    const coordinatorAttempt = `assistant_${"1".repeat(32)}`;
    await handlers["assistant:cancel"](
      { attemptId: coordinatorAttempt },
      {} as any,
    );
    expect(calls).toEqual([coordinatorAttempt]);
  });

  test("ready runtime returns login identity before supervised settlement and gates send on status", async () => {
    const calls: unknown[] = [];
    let status: { kind: "authentication-required" | "ready" } = {
      kind: "authentication-required",
    };
    let finishLogin!: () => void;
    const handlers = createAssistantIpcHandlers(
      {
        send: async (request) => {
          calls.push(["send", request]);
          return { kind: "accepted", attemptId: "send-1" };
        },
        cancel: async () => {},
      },
      {
        status: async () => status,
        login: async (attemptId) => {
          calls.push(["login", attemptId]);
          await new Promise<void>((resolve) => {
            finishLogin = resolve;
          });
          status = { kind: "ready" };
        },
        cancel: () => false,
      },
    );
    const login = (await handlers["assistant:login"]({}, {} as any)) as {
      kind: "started";
      attemptId: string;
    };
    expect(login.kind).toBe("started");
    expect(calls).toEqual([["login", login.attemptId]]);
    await expect(
      handlers["assistant:send"](
        { text: "before", timeZone: "UTC" },
        {} as any,
      ),
    ).resolves.toEqual({ kind: "rejected", reason: "authentication-required" });
    finishLogin();
    await Bun.sleep(0);
    await expect(
      handlers["assistant:send"]({ text: "after", timeZone: "UTC" }, {} as any),
    ).resolves.toEqual({ kind: "accepted", attemptId: "send-1" });
  });

  test("assistant revocation blocks producers and disposal joins a send already admitted", async () => {
    let finishSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const handlers = createAssistantIpcHandlers(
      {
        send: async () => {
          markSendStarted();
          await new Promise<void>((resolve) => {
            finishSend = resolve;
          });
          return { kind: "accepted", attemptId: "send-1" };
        },
        cancel: async () => {},
      },
      {
        status: async () => ({ kind: "ready" }),
        login: async () => {},
        cancel: () => false,
      },
    );
    const send = handlers["assistant:send"](
      { text: "before recovery", timeZone: "UTC" },
      {} as any,
    );
    await sendStarted;
    handlers.revoke();
    let disposed = false;
    const disposal = handlers.dispose().then(() => {
      disposed = true;
    });

    await expect(handlers["assistant:login"]({}, {} as any)).rejects.toThrow(
      "RECOVERY_UNAVAILABLE",
    );
    await expect(
      handlers["assistant:cancel"](
        { attemptId: `assistant_${"1".repeat(32)}` },
        {} as any,
      ),
    ).rejects.toThrow("RECOVERY_UNAVAILABLE");
    expect(disposed).toBe(false);
    finishSend();
    await Promise.all([send, disposal]);
  });

  test("assistant disposal aborts login work and drains coordinator work", async () => {
    const calls: string[] = [];
    const handlers = createAssistantIpcHandlers(
      {
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
        drain: async () => {
          calls.push("coordinator");
        },
      },
      {
        status: async () => ({ kind: "authentication-required" }),
        login: async (_attemptId, signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                calls.push("login-aborted");
                resolve();
              },
              { once: true },
            );
          });
        },
        cancel: () => false,
        close: async () => {
          calls.push("host");
        },
      },
    );
    await handlers["assistant:login"]({}, {} as any);
    await handlers.dispose();
    expect(calls).toEqual(["login-aborted", "coordinator", "host"]);
  });

  test("concurrent assistant login calls share one supervised attempt", async () => {
    const runtimeCalls: string[] = [];
    const challenges = createAssistantLoginChallengeRegistry();
    const handlers = createAssistantIpcHandlers(
      {
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
      },
      {
        status: async () => ({ kind: "authentication-required" }),
        login: async (attemptId) => {
          runtimeCalls.push(attemptId);
        },
        cancel: () => false,
      },
      { challenges, openUrl: async () => {} },
    );

    const [first, second] = (await Promise.all([
      handlers["assistant:login"]({}, {} as any),
      handlers["assistant:login"]({}, {} as any),
    ])) as Array<{ kind: "started"; attemptId: string }>;

    expect(second).toEqual(first);
    expect(runtimeCalls).toEqual([first!.attemptId]);
  });

  test("cancels a known login before deferred verification can register or spawn it", async () => {
    let releaseVerification!: () => void;
    const verification = new Promise<void>((resolvePromise) => {
      releaseVerification = resolvePromise;
    });
    let spawned = false;
    const coordinatorCancels: string[] = [];
    const handlers = createAssistantIpcHandlers(
      {
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async (attemptId) => {
          coordinatorCancels.push(attemptId);
        },
      },
      {
        status: async () => ({ kind: "authentication-required" }),
        login: async (_attemptId, signal) => {
          await verification;
          if (signal?.aborted) return;
          spawned = true;
        },
        cancel: () => false,
      },
    );

    const login = (await handlers["assistant:login"]({}, {} as any)) as {
      kind: "started";
      attemptId: string;
    };
    await handlers["assistant:cancel"](
      { attemptId: login.attemptId },
      {} as any,
    );
    releaseVerification();
    await Bun.sleep(0);
    await handlers["assistant:cancel"](
      { attemptId: login.attemptId },
      {} as any,
    );

    expect(spawned).toBe(false);
    expect(coordinatorCancels).toEqual([]);
  });

  test("routes the oldest login namespace safely after more than 32 terminal cycles", async () => {
    const coordinatorCancels: string[] = [];
    const runtimeCancels: string[] = [];
    const challenges = createAssistantLoginChallengeRegistry();
    const handlers = createAssistantIpcHandlers(
      {
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async (attemptId) => {
          coordinatorCancels.push(attemptId);
        },
      },
      {
        status: async () => ({ kind: "authentication-required" }),
        login: async (attemptId) => {
          challenges.invalidate(attemptId);
        },
        cancel: (attemptId) => {
          runtimeCancels.push(attemptId);
          return false;
        },
      },
      { challenges, openUrl: async () => {} },
    );
    const attempts: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const result = (await handlers["assistant:login"]({}, {} as any)) as {
        kind: "started";
        attemptId: string;
      };
      attempts.push(result.attemptId);
      await Bun.sleep(0);
    }

    await handlers["assistant:cancel"]({ attemptId: attempts[0]! }, {} as any);

    expect(
      attempts.every((attemptId) => /^login_[0-9a-f]{32}$/.test(attemptId)),
    ).toBe(true);
    expect(runtimeCancels).toEqual([attempts[0]]);
    expect(coordinatorCancels).toEqual([]);
  });

  test("rejects forged cancellation identities and routes coordinator namespace only", async () => {
    const coordinatorCancels: string[] = [];
    const handlers = createAssistantIpcHandlers({
      send: async () => ({ kind: "rejected", reason: "unavailable" }),
      cancel: async (attemptId) => {
        coordinatorCancels.push(attemptId);
      },
    });
    const coordinatorAttempt = `assistant_${"a".repeat(32)}`;

    expect(() =>
      handlers["assistant:cancel"]({ attemptId: "login_forged" }, {} as any),
    ).toThrow("identity");
    await handlers["assistant:cancel"](
      { attemptId: coordinatorAttempt },
      {} as any,
    );

    expect(coordinatorCancels).toEqual([coordinatorAttempt]);
  });

  test("assistant login URL opens only the exact active issued challenge once", async () => {
    const opened: string[] = [];
    const challenges = createAssistantLoginChallengeRegistry();
    const handlers = createAssistantIpcHandlers(
      {
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
      },
      {
        status: async () => ({ kind: "authentication-required" }),
        login: async () => {},
        cancel: () => false,
      },
      {
        challenges,
        openUrl: async (url) => {
          opened.push(url);
        },
      },
    );
    const login = (await handlers["assistant:login"]({}, {} as any)) as {
      kind: "started";
      attemptId: string;
    };
    expect(
      challenges.record(login.attemptId, {
        kind: "challenge-url",
        url: "https://auth.openai.com/device",
      }),
    ).toBeNull();
    expect(
      challenges.record(login.attemptId, {
        kind: "challenge-code",
        code: "ABCD-EFGH",
      }),
    ).toEqual({
      attemptId: login.attemptId,
      url: "https://auth.openai.com/device",
      code: "ABCD-EFGH",
    });

    for (const request of [
      {
        attemptId: login.attemptId,
        url: "https://auth.openai.com/other",
        code: "ABCD-EFGH",
      },
      {
        attemptId: login.attemptId,
        url: "https://auth.openai.com/device",
        code: "WRONG-0000",
      },
      {
        attemptId: "login_stale",
        url: "https://auth.openai.com/device",
        code: "ABCD-EFGH",
      },
    ]) {
      await expect(
        handlers["assistant:open-login-url"](request, {} as any),
      ).rejects.toThrow("not active");
    }
    await handlers["assistant:open-login-url"](
      {
        attemptId: login.attemptId,
        url: "https://auth.openai.com/device",
        code: "ABCD-EFGH",
      },
      {} as any,
    );
    expect(opened).toEqual(["https://auth.openai.com/device"]);
    await expect(
      handlers["assistant:open-login-url"](
        {
          attemptId: login.attemptId,
          url: "https://auth.openai.com/device",
          code: "ABCD-EFGH",
        },
        {} as any,
      ),
    ).rejects.toThrow("not active");
  });

  test("assistant challenge authority expires, invalidates on cancel, and ignores stale attempts", async () => {
    let now = 1_000;
    const challenges = createAssistantLoginChallengeRegistry({
      now: () => now,
      ttlMs: 10,
    });
    challenges.begin("login-a");
    challenges.record("login-a", {
      kind: "challenge-url",
      url: "https://auth.openai.com/a",
    });
    challenges.record("login-a", { kind: "challenge-code", code: "AAAA-0000" });
    challenges.begin("login-b");
    expect(
      challenges.record("login-a", {
        kind: "challenge-code",
        code: "STALE-0000",
      }),
    ).toBeNull();
    challenges.record("login-b", {
      kind: "challenge-url",
      url: "https://auth.openai.com/b",
    });
    challenges.record("login-b", { kind: "challenge-code", code: "BBBB-0000" });
    now += 11;
    expect(() =>
      challenges.consume({
        attemptId: "login-b",
        url: "https://auth.openai.com/b",
        code: "BBBB-0000",
      }),
    ).toThrow("not active");

    challenges.begin("login-c");
    challenges.record("login-c", {
      kind: "challenge-url",
      url: "https://auth.openai.com/c",
    });
    challenges.record("login-c", { kind: "challenge-code", code: "CCCC-0000" });
    challenges.invalidate("login-c");
    expect(() =>
      challenges.consume({
        attemptId: "login-c",
        url: "https://auth.openai.com/c",
        code: "CCCC-0000",
      }),
    ).toThrow("not active");
  });

  test("terminal login status invalidates the exact challenge before it reaches the renderer", () => {
    const challenges = createAssistantLoginChallengeRegistry();
    const broadcasts: unknown[] = [];
    challenges.begin(LOGIN_A);
    challenges.record(LOGIN_A, {
      kind: "challenge-url",
      url: "https://auth.openai.com/device",
    });
    challenges.record(LOGIN_A, {
      kind: "challenge-code",
      code: "ABCD-EFGH",
    });
    const forward = createCodexLoginEventForwarder({
      challenges,
      broadcast(event) {
        expect(challenges.activeAttemptId()).toBeNull();
        broadcasts.push(event);
      },
    });

    forward({
      attemptId: LOGIN_A,
      event: { kind: "status", status: { kind: "ready" } },
    });
    expect(broadcasts).toEqual([
      {
        type: "assistant-login",
        attemptId: LOGIN_A,
        event: { kind: "status", status: { kind: "ready" } },
      },
    ]);

    challenges.begin(LOGIN_B);
    forward({
      attemptId: LOGIN_A,
      event: { kind: "status", status: { kind: "authentication-required" } },
    });
    expect(challenges.activeAttemptId()).toBe(LOGIN_B);
    expect(broadcasts).toHaveLength(1);
  });

  test("assembles every contract channel and exposes only a renderer-scoped bootstrap", async () => {
    const handlers = createDesktopIpcHandlers({
      bootstrap: async () => ({
        bridgeVersion: 1,
        convexUrl: "http://127.0.0.1:3310",
        rendererAuthToken: "renderer.jwt.token",
        google: { kind: "disconnected" },
        assistant: { kind: "unavailable" },
      }),
      google: {
        "google:add-account": async () => ({
          kind: "cancelled",
          snapshot: { kind: "ready", accounts: [], oauthBusy: false },
        }),
        "google:clear-legacy-credentials": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:disconnect-account": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:reconnect-account": async () => ({
          kind: "cancelled",
          snapshot: { kind: "ready", accounts: [], oauthBusy: false },
        }),
        "google:status": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:sync-account": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
        "google:sync-all": async () => ({
          kind: "ready",
          accounts: [],
          oauthBusy: false,
        }),
      },
      settings: createSettingsIpcHandlers({
        snapshot: () => settingsSnapshot(),
        patch: async () => ({
          kind: "committed",
          snapshot: settingsSnapshot(1),
        }),
        reset: async () => ({
          kind: "committed",
          snapshot: settingsSnapshot(1),
        }),
        importLegacy: async () => ({
          kind: "committed",
          snapshot: settingsSnapshot(1),
        }),
      }),
    });

    expect(Object.keys(handlers).sort()).toEqual(
      [...DESKTOP_IPC_CHANNELS].sort(),
    );
    const value = await handlers["runtime:bootstrap"]({}, {} as any);
    expect(JSON.stringify(value)).not.toMatch(
      /admin|rootSecret|instanceSecret|refreshToken|accessToken|clientSecret|signingKey/i,
    );
  });

  test("sender, generation, and capability authorization gates every registered handler", async () => {
    const calls: string[] = [];
    const handlers = Object.fromEntries(
      DESKTOP_IPC_CHANNELS.map((channel) => [
        channel,
        async () => {
          calls.push(channel);
          return channel === "runtime:bootstrap"
            ? {
                bridgeVersion: 1,
                convexUrl: "http://127.0.0.1:3310",
                rendererAuthToken: "renderer.jwt.token",
                google: { kind: "disconnected" },
                assistant: { kind: "unavailable" },
                settings: settingsSnapshot(),
              }
            : channel === "google:status" ||
                channel === "google:disconnect-account" ||
                channel === "google:sync-account" ||
                channel === "google:sync-all"
              ? { kind: "ready", accounts: [], oauthBusy: false }
              : channel === "assistant:status" || channel === "assistant:login"
                ? { kind: "unavailable" }
                : channel === "assistant:send"
                  ? { kind: "rejected", reason: "unavailable" }
                  : channel === "recovery:export"
                    ? null
                    : undefined;
        },
      ]),
    ) as any;
    const installed = new Map<
      string,
      (event: any, payload: unknown) => Promise<unknown>
    >();
    const registry = createRendererIpcRegistry();
    registerDesktopIpc(
      {
        handle: (channel, handler) => installed.set(channel, handler as never),
      },
      handlers,
      registry,
    );

    for (const channel of DESKTOP_IPC_CHANNELS) {
      const renderer = fakeRenderer(
        100 + DESKTOP_IPC_CHANNELS.indexOf(channel),
      );
      registry.register(renderer, []);
      await expect(
        installed.get(channel)!(fakeEvent(renderer), {}),
      ).rejects.toThrow("Unauthorized desktop IPC sender");
    }
    expect(calls).toEqual([]);
  });
});
