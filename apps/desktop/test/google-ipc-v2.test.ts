import { describe, expect, test } from "bun:test";

import { createGoogleSyncIpcHandlers } from "../src/main/ipc/router";

const ACCOUNT_A = `gacc_${"a".repeat(43)}`;
const ACCOUNT_B = `gacc_${"b".repeat(43)}`;

function snapshot(syncing = false) {
  return {
    kind: "ready" as const,
    oauthBusy: false,
    accounts: [
      {
        accountId: ACCOUNT_A,
        accountEmail: "a@example.com",
        state: "connected" as const,
        syncState: syncing ? ("syncing" as const) : ("idle" as const),
      },
    ],
  };
}

describe("Google account IPC v2", () => {
  test("scopes reconnect, disconnect, and sync to the requested account", async () => {
    const calls: string[] = [];
    const handlers = createGoogleSyncIpcHandlers(
      {
        add: async () => ({ accountId: ACCOUNT_A }),
        clearLegacyCredentials: async () => {
          calls.push("clear-legacy");
        },
        reconnect: async (accountId) => {
          calls.push(`reconnect:${accountId}`);
          return { accountId };
        },
        disconnect: async (accountId) => {
          calls.push(`disconnect:${accountId}`);
        },
      },
      {
        wake: (trigger, accountId) =>
          calls.push(`wake:${trigger}:${accountId ?? "all"}`),
      },
      {
        getSnapshot: async () => snapshot(),
        reconcileAccounts: async () => {
          calls.push("reconcile");
        },
      },
    );

    await handlers["google:reconnect-account"](
      { accountId: ACCOUNT_A },
      {} as any,
    );
    await handlers["google:disconnect-account"](
      { accountId: ACCOUNT_A },
      {} as any,
    );
    await handlers["google:sync-account"]({ accountId: ACCOUNT_A }, {} as any);
    await handlers["google:sync-all"]({}, {} as any);
    await handlers["google:clear-legacy-credentials"]({}, {} as any);

    expect(calls).toEqual([
      `reconnect:${ACCOUNT_A}`,
      "reconcile",
      `wake:connection:${ACCOUNT_A}`,
      `disconnect:${ACCOUNT_A}`,
      "reconcile",
      `wake:manual:${ACCOUNT_A}`,
      "wake:manual:all",
      "clear-legacy",
      "reconcile",
    ]);
  });

  test("publishes only complete account snapshots after mutations and worker changes", async () => {
    const published: unknown[] = [];
    let workerChanged!: () => void;
    const handlers = createGoogleSyncIpcHandlers(
      {
        add: async () => ({ accountId: ACCOUNT_B }),
        clearLegacyCredentials: async () => {},
        reconnect: async (accountId) => ({ accountId }),
        disconnect: async () => {},
      },
      { wake: () => {} },
      {
        getSnapshot: async () => snapshot(true),
        publish: (value) => published.push(value),
        reconcileAccounts: async () => {},
        subscribeStatus: (listener) => {
          workerChanged = listener;
          return () => {};
        },
      },
    );

    const result = await handlers["google:add-account"]({}, {} as any);
    workerChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({ kind: "completed", snapshot: snapshot(true) });
    expect(published).toEqual([snapshot(true), snapshot(true)]);
    expect(published.every((value) => "accounts" in (value as object))).toBe(
      true,
    );
    await handlers.dispose();
  });

  test("maps user cancellation and the fixed account limit without leaking provider errors", async () => {
    for (const [message, kind] of [
      ["OAUTH_CALLBACK_CANCELLED", "cancelled"],
      ["GOOGLE_ACCOUNT_LIMIT_REACHED", "limit-reached"],
    ] as const) {
      const handlers = createGoogleSyncIpcHandlers(
        {
          add: async () => {
            throw new Error(message);
          },
          clearLegacyCredentials: async () => {},
          reconnect: async (accountId) => ({ accountId }),
          disconnect: async () => {},
        },
        { wake: () => {} },
        {
          getSnapshot: async () => snapshot(),
          reconcileAccounts: async () => {},
        },
      );
      await expect(
        handlers["google:add-account"]({}, {} as any),
      ).resolves.toEqual({
        kind,
        snapshot: snapshot(),
      });
    }
  });

  test("revocation blocks new v2 work and disposal joins an admitted add", async () => {
    let finish!: () => void;
    const handlers = createGoogleSyncIpcHandlers(
      {
        add: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { accountId: ACCOUNT_A };
        },
        clearLegacyCredentials: async () => {},
        reconnect: async (accountId) => ({ accountId }),
        disconnect: async () => {},
      },
      { wake: () => {} },
      {
        getSnapshot: async () => snapshot(),
        reconcileAccounts: async () => {},
      },
    );
    const adding = handlers["google:add-account"]({}, {} as any);
    await Promise.resolve();
    handlers.revoke();
    let disposed = false;
    const disposal = handlers.dispose().then(() => {
      disposed = true;
    });

    expect(disposed).toBe(false);
    await expect(handlers["google:sync-all"]({}, {} as any)).rejects.toThrow(
      "RECOVERY_UNAVAILABLE",
    );
    finish();
    await expect(adding).rejects.toThrow("RECOVERY_UNAVAILABLE");
    await disposal;
    expect(disposed).toBe(true);
  });
});
