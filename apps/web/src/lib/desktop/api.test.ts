// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import type { QaliDesktopApi } from "@qali/desktop-contracts";

import {
  createDesktopApi,
  applyDesktopDocumentChrome,
  desktopApiFor,
  desktopEnvironmentFor,
  type DesktopWindow,
} from "./api";
import { createDesktopSession } from "./auth-provider";

const GOOGLE_ACCOUNT_A = `gacc_${"a".repeat(43)}`;

function rendererToken(sequence = 1): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    aud: "qali-local-convex",
    exp: 2_000_000_000 + sequence,
    iat: 1_900_000_000,
    iss: "http://127.0.0.1:3312",
    jti: `token-${sequence}`,
    role: "renderer",
    sub: "qali-local-user",
  })}.signature`;
}

function bootstrap(sequence = 1) {
  return {
    bridgeVersion: 2 as const,
    convexUrl: "http://127.0.0.1:3310",
    rendererAuthToken: rendererToken(sequence),
    google: { kind: "ready" as const, accounts: [], oauthBusy: false },
    assistant: { kind: "unavailable" as const },
    settings: settingsSnapshot(),
  };
}

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

function fakeBridge(overrides: Partial<QaliDesktopApi> = {}) {
  const calls: string[] = [];
  let bootstrapSequence = 0;
  const bridge: QaliDesktopApi = {
    runtime: {
      bootstrap: async () => {
        calls.push("runtime.bootstrap");
        bootstrapSequence += 1;
        return bootstrap(bootstrapSequence);
      },
    },
    google: {
      status: async () => {
        calls.push("google.status");
        return { kind: "ready", accounts: [], oauthBusy: false };
      },
      addAccount: async () => {
        calls.push("google.addAccount");
        return {
          kind: "completed",
          snapshot: { kind: "ready", accounts: [], oauthBusy: false },
        };
      },
      reconnectAccount: async (accountId) => {
        calls.push(`google.reconnectAccount:${accountId}`);
        return {
          kind: "completed",
          snapshot: { kind: "ready", accounts: [], oauthBusy: false },
        };
      },
      disconnectAccount: async (accountId) => {
        calls.push(`google.disconnectAccount:${accountId}`);
        return { kind: "ready", accounts: [], oauthBusy: false };
      },
      syncAccount: async (accountId) => {
        calls.push(`google.syncAccount:${accountId}`);
        return { kind: "ready", accounts: [], oauthBusy: false };
      },
      syncAll: async () => {
        calls.push("google.syncAll");
        return { kind: "ready", accounts: [], oauthBusy: false };
      },
      clearLegacyCredentials: async () => {
        calls.push("google.clearLegacyCredentials");
        return { kind: "ready", accounts: [], oauthBusy: false };
      },
    },
    assistant: {
      status: async () => ({ kind: "unavailable" }),
      login: async () => ({
        kind: "rejected",
        status: { kind: "unavailable" },
      }),
      openLoginUrl: async () => {},
      send: async () => ({ kind: "rejected", reason: "unavailable" }),
      cancel: async () => {},
    },
    settings: {
      get: async () => settingsSnapshot(),
      patch: async () => ({ kind: "committed", snapshot: settingsSnapshot(1) }),
      reset: async () => ({ kind: "committed", snapshot: settingsSnapshot(1) }),
      importLegacy: async () => ({
        kind: "committed",
        snapshot: settingsSnapshot(1),
      }),
    },
    updates: {
      status: async () => ({
        kind: "disabled",
        currentVersion: "0.1.0",
        reason: "development",
      }),
      check: async () => ({
        kind: "disabled",
        currentVersion: "0.1.0",
        reason: "development",
      }),
      install: async () => ({ kind: "restarting" }),
    },
    recovery: {
      exportData: async () => ({ kind: "cancelled" }),
      listBackups: async () => [],
      restore: async (backupId) => ({
        kind: "restored",
        backupId,
        restartRequired: true,
      }),
      reset: async () => ({ kind: "reset", restartRequired: true }),
    },
    events: { subscribe: () => () => {} },
    ...overrides,
  };
  return { bridge, calls };
}

describe("desktop bootstrap boundary", () => {
  test("marks only the desktop document for native titlebar-safe layout", () => {
    const desktopRoot = { dataset: {} } as unknown as HTMLElement;
    const webRoot = {
      dataset: { qaliDesktop: "" },
    } as unknown as HTMLElement;

    applyDesktopDocumentChrome(desktopRoot, true);
    applyDesktopDocumentChrome(webRoot, false);

    expect(desktopRoot.dataset.qaliDesktop).toBe("");
    expect(webRoot.dataset.qaliDesktop).toBeUndefined();
  });

  test("rejects malformed, version-mismatched, and extra-authority payloads", async () => {
    const rejected = [
      { ...bootstrap(), bridgeVersion: 1 },
      { ...bootstrap(), convexUrl: "https://convex.example.com" },
      { ...bootstrap(), rendererAuthToken: "not-a-jwt" },
      { ...bootstrap(), adminKey: "must-not-cross" },
      {
        ...bootstrap(),
        google: {
          kind: "ready",
          oauthBusy: false,
          accounts: [
            {
              accountId: GOOGLE_ACCOUNT_A,
              accountEmail: "me@example.com",
              state: "connected",
              syncState: "idle",
              refreshToken: "secret",
            },
          ],
        },
      },
    ];

    for (const value of rejected) {
      const { bridge } = fakeBridge({
        runtime: { bootstrap: async () => value as never },
      });
      await expect(createDesktopApi(bridge).bootstrap()).rejects.toBeDefined();
    }
  });

  test("accepts only public local bootstrap material", async () => {
    const { bridge } = fakeBridge();
    const value = await createDesktopApi(bridge).bootstrap();
    const serialized = JSON.stringify(value);

    expect(value.convexUrl).toBe("http://127.0.0.1:3310");
    expect(serialized).not.toMatch(
      /admin|rootSecret|instanceSecret|refreshToken|accessToken|clientSecret|signingKey/i,
    );
  });

  test("selects desktop only when the named preload bridge exists", () => {
    const { bridge } = fakeBridge();
    expect(desktopEnvironmentFor({ qali: bridge })).toBe("desktop");
    expect(desktopEnvironmentFor({} as DesktopWindow)).toBe("web");
  });

  test("an own qali property never falls through to hosted auth when malformed", () => {
    for (const qali of [undefined, null, false, {}]) {
      const windowValue = { qali } as DesktopWindow;
      expect(desktopEnvironmentFor(windowValue)).toBe("desktop");
      expect(() => desktopApiFor(windowValue)).toThrow(
        "Desktop preload bridge is malformed",
      );
    }

    const inherited = Object.create({
      qali: fakeBridge().bridge,
    }) as DesktopWindow;
    expect(desktopEnvironmentFor(inherited)).toBe("web");
    expect(desktopApiFor(inherited)).toBeNull();
  });
});

describe("desktop Convex auth session", () => {
  test("uses the local URL and refreshes the renderer token only through bootstrap", async () => {
    const { bridge, calls } = fakeBridge();
    const session = createDesktopSession(createDesktopApi(bridge));

    const initial = await session.bootstrap();
    const cached = await session.fetchAccessToken({ forceRefreshToken: false });
    const refreshed = await session.fetchAccessToken({
      forceRefreshToken: true,
    });

    expect(initial.convexUrl).toBe("http://127.0.0.1:3310");
    expect(cached).toBe(rendererToken(1));
    expect(refreshed).toBe(rendererToken(2));
    expect(calls).toEqual(["runtime.bootstrap", "runtime.bootstrap"]);
  });

  test("fails closed when bootstrap cannot establish a valid desktop session", async () => {
    const { bridge } = fakeBridge({
      runtime: {
        bootstrap: async () => ({ ...bootstrap(), bridgeVersion: 1 }) as never,
      },
    });
    const session = createDesktopSession(createDesktopApi(bridge));

    await expect(session.bootstrap()).rejects.toBeDefined();
    expect(session.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      isLoading: false,
    });
  });

  test("refreshes an authenticated token without routing through auth loading", async () => {
    let finishRefresh!: (value: ReturnType<typeof bootstrap>) => void;
    const { bridge } = fakeBridge({
      runtime: {
        bootstrap: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 1) return bootstrap(1);
            return await new Promise<ReturnType<typeof bootstrap>>(
              (resolve) => {
                finishRefresh = resolve;
              },
            );
          };
        })(),
      },
    });
    const session = createDesktopSession(createDesktopApi(bridge));
    await session.bootstrap();

    const refresh = session.fetchAccessToken({ forceRefreshToken: true });
    expect(session.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      isLoading: false,
    });
    finishRefresh(bootstrap(2));
    await refresh;
  });

  test("retries one transient forced refresh without erasing the valid session", async () => {
    let calls = 0;
    const { bridge } = fakeBridge({
      runtime: {
        bootstrap: async () => {
          calls += 1;
          if (calls === 2) throw new Error("transient IPC failure");
          return bootstrap(calls === 1 ? 1 : 2);
        },
      },
    });
    const session = createDesktopSession(createDesktopApi(bridge));
    await session.bootstrap();

    const refreshed = await session.fetchAccessToken({
      forceRefreshToken: true,
    });

    expect(refreshed).toBe(rendererToken(2));
    expect(calls).toBe(3);
    expect(session.getSnapshot()).toMatchObject({
      bootstrap: bootstrap(2),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  test("persistent refresh failure automatically re-arms Convex after issuer recovery", async () => {
    let calls = 0;
    const scheduled: Array<{
      cancelled: boolean;
      delayMs: number;
      run(): Promise<void>;
    }> = [];
    const { bridge } = fakeBridge({
      runtime: {
        bootstrap: async () => {
          calls += 1;
          if (calls === 2 || calls === 3) throw new Error("IPC unavailable");
          return bootstrap(calls === 1 ? 1 : 2);
        },
      },
    });
    const session = createDesktopSession(createDesktopApi(bridge), {
      schedule(delayMs: number, task: () => Promise<void>) {
        const entry = { cancelled: false, delayMs, run: task };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    });
    await session.bootstrap();
    const initialFetcher = session.getAuthFetcher();
    let rearmedToken: string | null | undefined;
    session.subscribe(() => {
      const nextFetcher = session.getAuthFetcher();
      if (nextFetcher !== initialFetcher) {
        void nextFetcher({ forceRefreshToken: false }).then((token) => {
          rearmedToken = token;
        });
      }
    });

    await expect(
      session.fetchAccessToken({ forceRefreshToken: true }),
    ).resolves.toBeNull();
    expect(calls).toBe(3);
    expect(session.getSnapshot()).toMatchObject({
      bootstrap: bootstrap(1),
      isAuthenticated: true,
      isLoading: false,
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(1_000);

    await scheduled[0]!.run();
    await Promise.resolve();

    expect(session.getAuthFetcher()).not.toBe(initialFetcher);
    expect(rearmedToken).toBe(rendererToken(2));
    expect(calls).toBe(4);
  });

  test("automatic refresh recovery backs off and is cancelled on dispose", async () => {
    let calls = 0;
    const scheduled: Array<{
      cancelled: boolean;
      delayMs: number;
      run(): Promise<void>;
    }> = [];
    const { bridge } = fakeBridge({
      runtime: {
        bootstrap: async () => {
          calls += 1;
          if (calls === 1) return bootstrap(1);
          throw new Error("IPC unavailable");
        },
      },
    });
    const session = createDesktopSession(createDesktopApi(bridge), {
      schedule(delayMs: number, task: () => Promise<void>) {
        const entry = { cancelled: false, delayMs, run: task };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    });
    await session.bootstrap();
    await session.fetchAccessToken({ forceRefreshToken: true });

    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1_000]);
    await scheduled[0]!.run();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1_000, 2_000]);
    expect(calls).toBe(4);

    session.dispose();
    expect(scheduled[1]?.cancelled).toBe(true);
  });

  test("dispose ignores a late successful ordinary refresh", async () => {
    let resolveRefresh!: (value: ReturnType<typeof bootstrap>) => void;
    let calls = 0;
    const { bridge } = fakeBridge({
      runtime: {
        bootstrap: async () => {
          calls += 1;
          if (calls === 1) return bootstrap(1);
          return await new Promise<ReturnType<typeof bootstrap>>((resolve) => {
            resolveRefresh = resolve;
          });
        },
      },
    });
    const session = createDesktopSession(createDesktopApi(bridge));
    await session.bootstrap();
    const snapshot = session.getSnapshot();
    const authFetcher = session.getAuthFetcher();
    let publishes = 0;
    session.subscribe(() => {
      publishes += 1;
    });

    const refresh = session.fetchAccessToken({ forceRefreshToken: true });
    session.dispose();
    resolveRefresh(bootstrap(2));

    await expect(refresh).resolves.toBeNull();
    expect(calls).toBe(2);
    expect(publishes).toBe(0);
    expect(session.getSnapshot()).toBe(snapshot);
    expect(session.getAuthFetcher()).toBe(authFetcher);
  });

  test("dispose ignores a late failed ordinary refresh without scheduling recovery", async () => {
    let rejectRefresh!: (error: Error) => void;
    let calls = 0;
    const scheduled: number[] = [];
    const { bridge } = fakeBridge({
      runtime: {
        bootstrap: async () => {
          calls += 1;
          if (calls === 1) return bootstrap(1);
          if (calls === 2) {
            return await new Promise<never>((_resolve, reject) => {
              rejectRefresh = reject;
            });
          }
          throw new Error("unexpected retry after dispose");
        },
      },
    });
    const session = createDesktopSession(createDesktopApi(bridge), {
      schedule(delayMs, _task) {
        scheduled.push(delayMs);
        return () => {};
      },
    });
    await session.bootstrap();
    const snapshot = session.getSnapshot();
    let publishes = 0;
    session.subscribe(() => {
      publishes += 1;
    });

    const refresh = session.fetchAccessToken({ forceRefreshToken: true });
    session.dispose();
    rejectRefresh(new Error("late IPC failure"));

    await expect(refresh).resolves.toBeNull();
    expect(calls).toBe(2);
    expect(scheduled).toEqual([]);
    expect(publishes).toBe(0);
    expect(session.getSnapshot()).toBe(snapshot);
  });
});

test("Google controls invoke only their named preload intentions", async () => {
  const { bridge, calls } = fakeBridge();
  const api = createDesktopApi(bridge);

  await api.googleStatus();
  await api.addGoogleAccount();
  await api.reconnectGoogleAccount(GOOGLE_ACCOUNT_A);
  await api.disconnectGoogleAccount(GOOGLE_ACCOUNT_A);
  await api.syncGoogleAccount(GOOGLE_ACCOUNT_A);
  await api.syncAllGoogleAccounts();
  await api.clearLegacyGoogleCredentials();

  expect(calls).toEqual([
    "google.status",
    "google.addAccount",
    `google.reconnectAccount:${GOOGLE_ACCOUNT_A}`,
    `google.disconnectAccount:${GOOGLE_ACCOUNT_A}`,
    `google.syncAccount:${GOOGLE_ACCOUNT_A}`,
    "google.syncAll",
    "google.clearLegacyCredentials",
  ]);
});

test("desktop Qali identity remains separate from Google integrations", async () => {
  const statusModule = (await import("./status")) as Record<string, unknown>;
  expect(statusModule).not.toHaveProperty("userForGoogleStatus");
});
