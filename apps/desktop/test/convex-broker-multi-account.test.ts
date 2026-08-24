import { describe, expect, test } from "bun:test";

import { ConvexCalendarBrokerClient } from "../src/main/convex/broker-client";

describe("ConvexCalendarBrokerClient multi-account views", () => {
  test("creates account-scoped worker views without creating another transport", async () => {
    const broker = new ConvexCalendarBrokerClient({
      deploymentUrl: "http://127.0.0.1:3210/",
      tokenProvider: {
        getToken: async () => "local-token",
      },
    } as any);
    try {
      const first = broker.forAccount("gacc_first");
      const second = broker.forAccount("gacc_second");

      expect(first).not.toBe(second);
      expect(first).not.toBe(broker);
      expect(second).not.toBe(broker);
    } finally {
      await broker.close();
    }
  });

  test("scopes subscriptions and queries per account while only the owner closes the shared transport", async () => {
    const subscriptions: Array<{
      accountId: string;
      listener(value: unknown): void;
    }> = [];
    let closeCount = 0;
    const client = {
      close: async () => {
        closeCount += 1;
      },
      mutation: async () => ({ applied: 0 }),
      onUpdate: (
        _reference: unknown,
        args: { accountId: string },
        listener: (value: unknown) => void,
      ) => {
        subscriptions.push({ accountId: args.accountId, listener });
        return () => {};
      },
      query: async (_reference: unknown, args: { accountId: string }) => ({
        calendars: [
          {
            accountId: args.accountId,
            calendarId: `gcal_${args.accountId}`,
            providerCalendarId: "primary",
          },
        ],
        pendingCount: 0,
      }),
      setAuth: () => {},
    };
    const broker = new ConvexCalendarBrokerClient({
      client,
      deploymentUrl: "http://127.0.0.1:3210/",
      tokenProvider: { getToken: async () => "local-token" },
    } as any);
    const first = broker.forAccount("gacc_first");
    const second = broker.forAccount("gacc_second");
    let firstWakeCount = 0;
    let secondWakeCount = 0;
    first.subscribePending(() => {
      firstWakeCount += 1;
    });
    second.subscribePending(() => {
      secondWakeCount += 1;
    });

    expect(await first.listSyncCalendars("gacc_first")).toEqual([
      {
        accountId: "gacc_first",
        calendarId: "gcal_gacc_first",
        providerCalendarId: "primary",
      },
    ]);
    expect(subscriptions.map((entry) => entry.accountId)).toEqual([
      "gacc_first",
      "gacc_second",
    ]);
    subscriptions[0]!.listener({
      calendars: [],
      pendingCount: 1,
    });
    expect(firstWakeCount).toBe(1);
    expect(secondWakeCount).toBe(0);

    await first.close?.();
    await second.close?.();
    expect(closeCount).toBe(0);
    await broker.close();
    expect(closeCount).toBe(1);
  });

  test("rejects calendars and leases returned for another account", async () => {
    const client = {
      close: async () => {},
      mutation: async () => [
        {
          operationId: "op_1",
          accountId: "gacc_attacker",
          calendarId: "gcal_local",
          providerCalendarId: "primary",
          localEventId: "event_1",
          kind: "delete",
          payload: {},
          state: "leased",
          attemptCount: 1,
          leaseId: "lease_1",
          leasedFromState: "pending",
          consumedOperationIds: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      onUpdate: () => () => {},
      query: async () => ({
        calendars: [
          {
            accountId: "gacc_attacker",
            calendarId: "gcal_local",
            providerCalendarId: "primary",
          },
        ],
        pendingCount: 0,
      }),
      setAuth: () => {},
    };
    const broker = new ConvexCalendarBrokerClient({
      client,
      deploymentUrl: "http://127.0.0.1:3210/",
      tokenProvider: { getToken: async () => "local-token" },
    } as any);
    try {
      await expect(broker.listSyncCalendars("gacc_victim")).rejects.toThrow(
        "CALENDAR_BROKER_ACCOUNT_MISMATCH",
      );
      await expect(
        broker.leaseOperations("gacc_victim", "lease_1"),
      ).rejects.toThrow("CALENDAR_BROKER_ACCOUNT_MISMATCH");
    } finally {
      await broker.close();
    }
  });
});
