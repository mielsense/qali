// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import type { QaliDesktopApi } from "@qali/desktop-contracts";

import {
  assistantCopy,
  assistantInstallationCopy,
  createDesktopAssistant,
  createDesktopAssistantSession,
  desktopAssistantFor,
} from "./assistant";

const LOGIN_A = `login_${"a".repeat(32)}`;
const LOGIN_B = `login_${"b".repeat(32)}`;
const LOGIN_C = `login_${"c".repeat(32)}`;
const LOGIN_D = `login_${"d".repeat(32)}`;
const LOGIN_E = `login_${"e".repeat(32)}`;
const LOGIN_F = `login_${"f".repeat(32)}`;
const ASSISTANT_A = `assistant_${"a".repeat(32)}`;

function bridge(overrides: Partial<QaliDesktopApi["assistant"]> = {}) {
  const calls: unknown[] = [];
  const value = {
    assistant: {
      status: async () => ({ kind: "unavailable" as const }),
      login: async () => ({
        kind: "rejected" as const,
        status: { kind: "unavailable" as const },
      }),
      openLoginUrl: async () => {},
      chooseCodexInstallation: async () => ({ kind: "cancelled" as const }),
      send: async (request: { text: string; timeZone: string }) => {
        calls.push(["send", request]);
        return { kind: "rejected" as const, reason: "unavailable" as const };
      },
      cancel: async (attemptId: string) => {
        calls.push(["cancel", attemptId]);
      },
      ...overrides,
    },
  };
  return { value: value as never, calls };
}

describe("desktop assistant boundary", () => {
  test("chooses a Codex installation without renderer path authority", async () => {
    const calls: unknown[] = [];
    const fake = bridge({
      chooseCodexInstallation: async () => {
        calls.push("choose");
        return { kind: "selected", status: { kind: "ready-degraded" } };
      },
    } as never);
    await expect(
      createDesktopAssistant(fake.value).chooseCodexInstallation(),
    ).resolves.toEqual({
      kind: "selected",
      status: { kind: "ready-degraded" },
    });
    expect(calls).toEqual(["choose"]);
    expect(assistantInstallationCopy({ kind: "missing" })).toMatch(
      /not found/i,
    );
  });

  test("uses only named intentions and validates strict results", async () => {
    const fake = bridge({
      status: async () => ({ kind: "ready", token: "secret" }) as never,
    });
    const assistant = createDesktopAssistant(fake.value);
    await expect(assistant.status()).rejects.toBeDefined();
    expect(await assistant.send(" hello ", "Europe/Paris")).toEqual({
      kind: "rejected",
      reason: "unavailable",
    });
    await assistant.cancel(ASSISTANT_A);
    expect(fake.calls).toEqual([
      ["send", { text: "hello", timeZone: "Europe/Paris" }],
      ["cancel", ASSISTANT_A],
    ]);
  });

  test("rejects raw authority fields and malformed send results", async () => {
    const fake = bridge({
      send: async () =>
        ({
          kind: "accepted",
          attemptId: "a",
          prompt: "raw",
          apiKey: "x",
        }) as never,
    });
    await expect(
      createDesktopAssistant(fake.value).send("hello", "UTC"),
    ).rejects.toBeDefined();
  });

  test("selects hosted only when the preload bridge property is absent", () => {
    expect(desktopAssistantFor({})).toBeNull();
    expect(() => desktopAssistantFor({ qali: undefined })).toThrow(
      "Desktop preload bridge is malformed",
    );
  });

  test("maps every typed blocked/error state to truthful copy", () => {
    expect(assistantCopy({ kind: "authentication-required" })).toMatch(
      /sign in/i,
    );
    expect(assistantCopy({ kind: "probing" })).toMatch(/checking/i);
    expect(assistantCopy({ kind: "ready-degraded" })).toMatch(/limited/i);
    expect(assistantCopy({ kind: "needs-reprobe" })).toMatch(/changed/i);
    expect(assistantCopy({ kind: "incompatible" })).toMatch(/incompatible/i);
    expect(assistantCopy({ kind: "probe-failed" })).toMatch(/verified/i);
    expect(assistantCopy({ kind: "unavailable" })).toMatch(/unavailable/i);
    expect(assistantCopy({ kind: "ready" })).toBeNull();
  });
});

describe("desktop assistant live login session", () => {
  test("settles an initial probing observation with one authoritative follow-up", async () => {
    const statuses = [{ kind: "probing" as const }, { kind: "ready" as const }];
    let statusCalls = 0;
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => {
          statusCalls += 1;
          return statuses.shift() ?? { kind: "ready" as const };
        },
        login: async () => ({
          kind: "rejected" as const,
          status: { kind: "ready" as const },
        }),
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
        openLoginUrl: async () => {},
      },
      events: { subscribe: () => () => {} },
    } as never);

    await expect(session.refreshStatus()).resolves.toEqual({ kind: "ready" });
    expect(statusCalls).toBe(2);
    expect(session.getSnapshot().status).toEqual({ kind: "ready" });
    session.dispose();
  });

  test("captures a challenge emitted before login settles and opens only that exact URL", async () => {
    let listener: ((event: unknown) => void) | undefined;
    let settle!: (value: unknown) => void;
    const opened: unknown[] = [];
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => ({ kind: "authentication-required" }),
        login: async () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
        openLoginUrl: async (request: unknown) => {
          opened.push(request);
        },
      },
      events: {
        subscribe(next: (event: unknown) => void) {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
    } as never);
    const login = session.login();
    listener?.({
      type: "assistant-login",
      attemptId: LOGIN_A,
      event: {
        kind: "challenge",
        url: "https://auth.openai.com/device",
        code: "ABCD-EFGH",
      },
    });
    settle({ kind: "started", attemptId: LOGIN_A });
    await login;
    expect(session.getSnapshot().challenge).toEqual({
      url: "https://auth.openai.com/device",
      code: "ABCD-EFGH",
    });
    await session.openChallenge();
    expect(opened).toEqual([
      {
        attemptId: LOGIN_A,
        url: "https://auth.openai.com/device",
        code: "ABCD-EFGH",
      },
    ]);
  });

  test("an unscoped status from an old attempt cannot clear the active challenge", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const attempts = [LOGIN_A, LOGIN_B];
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => ({ kind: "authentication-required" }),
        login: async () => ({ kind: "started", attemptId: attempts.shift()! }),
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
        openLoginUrl: async () => {},
      },
      events: {
        subscribe(next: (event: unknown) => void) {
          listener = next;
          return () => {};
        },
      },
    } as never);

    await session.login();
    listener?.({
      type: "assistant-login",
      attemptId: LOGIN_A,
      event: { kind: "status", status: { kind: "authentication-required" } },
    });
    await session.login();
    listener?.({
      type: "assistant-login",
      attemptId: LOGIN_B,
      event: {
        kind: "challenge",
        url: "https://auth.openai.com/device",
        code: "BBBB-0000",
      },
    });
    listener?.({ type: "assistant-status", status: { kind: "ready" } });

    expect(session.getSnapshot()).toMatchObject({
      attemptId: LOGIN_B,
      status: { kind: "authentication-required" },
      challenge: {
        url: "https://auth.openai.com/device",
        code: "BBBB-0000",
      },
    });
    session.dispose();
  });

  test("concurrent login callers share one IPC attempt", async () => {
    let settle!: (value: unknown) => void;
    let loginCalls = 0;
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => ({ kind: "authentication-required" }),
        login: async () => {
          loginCalls += 1;
          return await new Promise((resolve) => {
            settle = resolve;
          });
        },
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
        openLoginUrl: async () => {},
      },
      events: { subscribe: () => () => {} },
    } as never);

    const first = session.login();
    const second = session.login();
    expect(loginCalls).toBe(1);
    settle({ kind: "started", attemptId: LOGIN_C });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "started", attemptId: LOGIN_C },
      { kind: "started", attemptId: LOGIN_C },
    ]);
    session.dispose();
  });

  test("cancel before the login receipt cancels the late attempt identity", async () => {
    let settle!: (value: unknown) => void;
    const cancelled: string[] = [];
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => ({ kind: "authentication-required" }),
        login: async () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async (attemptId: string) => {
          cancelled.push(attemptId);
        },
        openLoginUrl: async () => {},
      },
      events: { subscribe: () => () => {} },
    } as never);

    const login = session.login();
    await session.cancel();
    settle({ kind: "started", attemptId: LOGIN_D });
    await login;

    expect(cancelled).toEqual([LOGIN_D]);
    expect(session.getSnapshot().attemptId).toBeNull();
    session.dispose();
  });

  test("dispose before the login receipt cancels the late attempt identity", async () => {
    let settle!: (value: unknown) => void;
    const cancelled: string[] = [];
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => ({ kind: "authentication-required" }),
        login: async () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async (attemptId: string) => {
          cancelled.push(attemptId);
        },
        openLoginUrl: async () => {},
      },
      events: { subscribe: () => () => {} },
    } as never);

    const login = session.login();
    session.dispose();
    settle({ kind: "started", attemptId: LOGIN_E });
    await login;

    expect(cancelled).toEqual([LOGIN_E]);
    expect(session.getSnapshot().attemptId).toBeNull();
  });

  test("ignores stale generations and clears on cancellation and disposal", async () => {
    const listeners = new Set<(event: unknown) => void>();
    let unsubscribed = 0;
    const cancelled: string[] = [];
    const loginAttempts = [LOGIN_A, LOGIN_B];
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => ({ kind: "authentication-required" }),
        login: async () => ({
          kind: "started",
          attemptId: loginAttempts.shift()!,
        }),
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async (id: string) => {
          cancelled.push(id);
        },
        openLoginUrl: async () => {},
      },
      events: {
        subscribe(next: (event: unknown) => void) {
          listeners.add(next);
          return () => {
            listeners.delete(next);
            unsubscribed += 1;
          };
        },
      },
    } as never);
    await session.login();
    const active = session.getSnapshot().attemptId!;
    for (const next of listeners) {
      next({
        type: "assistant-login",
        attemptId: LOGIN_F,
        event: {
          kind: "challenge",
          url: "https://auth.openai.com/stale",
          code: "STALE-0000",
        },
      });
      next({
        type: "assistant-login",
        attemptId: active,
        event: {
          kind: "challenge",
          url: "https://auth.openai.com/device",
          code: "LIVE-0000",
        },
      });
    }
    expect(session.getSnapshot().challenge?.code).toBe("LIVE-0000");
    for (const next of listeners) {
      next({
        type: "assistant-login",
        attemptId: active,
        event: { kind: "status", status: { kind: "authentication-required" } },
      });
    }
    expect(session.getSnapshot().attemptId).toBeNull();
    expect(session.getSnapshot().challenge).toBeNull();

    await session.login();
    const cancelledAttempt = session.getSnapshot().attemptId!;
    await session.cancel();
    expect(cancelled).toEqual([cancelledAttempt]);
    expect(session.getSnapshot().challenge).toBeNull();
    session.dispose();
    expect(unsubscribed).toBe(1);
    expect(session.getSnapshot().challenge).toBeNull();
  });

  test("rejects malformed login events and extra authority fields", () => {
    let listener: ((event: unknown) => void) | undefined;
    const session = createDesktopAssistantSession({
      assistant: {
        status: async () => ({ kind: "authentication-required" }),
        login: async () => ({ kind: "started", attemptId: LOGIN_A }),
        send: async () => ({ kind: "rejected", reason: "unavailable" }),
        cancel: async () => {},
        openLoginUrl: async () => {},
      },
      events: {
        subscribe(next: (event: unknown) => void) {
          listener = next;
          return () => {};
        },
      },
    } as never);
    expect(() =>
      listener?.({
        type: "assistant-login",
        attemptId: LOGIN_A,
        event: {
          kind: "challenge",
          url: "javascript:alert(1)",
          code: "ABCD",
          apiKey: "secret",
        },
      }),
    ).toThrow();
    session.dispose();
  });
});
