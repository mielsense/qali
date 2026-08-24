/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";

import { api, internal } from "../../_generated/api";
import schema from "../../schema";
import { LOCAL_AUTH_ISSUERS } from "./identity";

const modules = import.meta.glob("../../**/*.ts");
const USER = "qali-local-user";

function identity(role: "renderer" | "desktop_broker") {
  return {
    issuer: LOCAL_AUTH_ISSUERS.test,
    subject: USER,
    tokenIdentifier: `${LOCAL_AUTH_ISSUERS.test}|${USER}`,
    email: "local@qali.app",
    name: "Qali User",
    role,
  };
}

function desktopMutation(name: string): FunctionReference<"mutation"> {
  return (
    api as unknown as Record<
      string,
      Record<string, FunctionReference<"mutation">>
    >
  ).desktopCalendar![name]!;
}

function desktopQuery(name: string): FunctionReference<"query"> {
  return (
    api as unknown as Record<string, Record<string, FunctionReference<"query">>>
  ).desktopCalendar![name]!;
}

const snapshot = {
  localEventId: "local_event_001",
  accountId: "account_001",
  calendarId: "primary",
  remoteEventId: "remote-1",
  summary: "Remote",
  startMs: 10,
  endMs: 20,
  allDay: false,
  status: "confirmed",
};

async function seedPending(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("calendarOperations", {
      userId: USER,
      operationId: "operation_001",
      idempotencyKey: "operation_001",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_event_001",
      remoteEventId: "remote-1",
      providerCalendarId: "primary",
      providerEventId: "remote-1",
      kind: "update",
      payload: { patch: { summary: "Local" } },
      baseRemoteSnapshot: snapshot,
      baseRemoteEtag: "etag-1",
      state: "pending",
      status: "pending",
      leaseReady: true,
      nextLeaseAt: 0,
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

describe("desktop calendar broker", () => {
  test("enqueue is idempotent only for the exact immutable command", async () => {
    const t = convexTest(schema, modules);
    const command = {
      userId: USER,
      operationId: "operation_exact_001",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_event_001",
      remoteEventId: "remote-1",
      kind: "update" as const,
      payload: { patch: { summary: "Local" } },
      baseRemoteSnapshot: snapshot,
      baseRemoteEtag: "etag-1",
    };
    const first = await t.mutation(
      internal.desktopCalendar.enqueueOperation,
      command,
    );
    const second = await t.mutation(
      internal.desktopCalendar.enqueueOperation,
      command,
    );
    expect(second).toBe(first);
    const projection = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (q) =>
          q.eq("userId", USER).eq("localEventId", "local_event_001"),
        )
        .unique(),
    );
    expect(projection).toMatchObject({
      summary: "Local",
      remoteSnapshot: snapshot,
      syncState: "pending",
    });
    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        ...command,
        payload: { patch: { summary: "Different" } },
      }),
    ).rejects.toThrow("CALENDAR_OPERATION_IDEMPOTENCY_MISMATCH");
  });

  test("an exact retry keeps the predecessor inferred by the first insertion", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const command = {
      userId: USER,
      operationId: "operation_chain_002",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_event_001",
      remoteEventId: "remote-1",
      kind: "update" as const,
      payload: { patch: { location: "Room B" } },
      baseRemoteSnapshot: snapshot,
      baseRemoteEtag: "etag-1",
    };

    const first = await t.mutation(
      internal.desktopCalendar.enqueueOperation,
      command,
    );
    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, command),
    ).resolves.toBe(first);
  });

  test("explicit predecessor readiness uses that row rather than the latest row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_explicit_blocked",
        idempotencyKey: "operation_explicit_blocked",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_explicit_001",
        kind: "create",
        payload: {
          event: {
            ...snapshot,
            localEventId: "local_explicit_001",
            remoteEventId: undefined,
          },
        },
        state: "conflict",
        status: "failed",
        attemptCount: 0,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_explicit_latest",
        idempotencyKey: "operation_explicit_latest",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_explicit_001",
        kind: "create",
        payload: {
          event: {
            ...snapshot,
            localEventId: "local_explicit_001",
            remoteEventId: undefined,
          },
        },
        state: "succeeded",
        status: "succeeded",
        attemptCount: 1,
        createdAt: 2,
        updatedAt: 2,
      });
    });

    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_explicit_child",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_explicit_001",
      kind: "create",
      payload: {
        event: {
          ...snapshot,
          localEventId: "local_explicit_001",
          remoteEventId: undefined,
        },
      },
      predecessorOperationId: "operation_explicit_blocked",
    });
    const child = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_explicit_child"),
        )
        .unique(),
    );
    expect(child).toMatchObject({
      predecessorOperationId: "operation_explicit_blocked",
      leaseReady: false,
    });
  });

  test("cannot bypass a remote event precondition by omitting its remote id", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [{ remoteSnapshot: snapshot, remoteEtag: "etag-1" }],
    });

    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        userId: USER,
        operationId: "operation_omitted_remote_id",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_event_001",
        kind: "update",
        payload: { patch: { summary: "Forged local update" } },
      }),
    ).rejects.toThrow("CALENDAR_COMMAND_PRECONDITION_REQUIRED");
  });

  test("existing remote events reject forged scope, baseline, and etag", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [{ remoteSnapshot: snapshot, remoteEtag: "etag-1" }],
    });
    const valid = {
      userId: USER,
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_event_001",
      remoteEventId: "remote-1",
      kind: "update" as const,
      payload: { patch: { summary: "Local" } },
      baseRemoteSnapshot: snapshot,
      baseRemoteEtag: "etag-1",
    };

    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        ...valid,
        operationId: "operation_forged_account",
        accountId: "account_forged",
      }),
    ).rejects.toThrow("CALENDAR_COMMAND_SCOPE_MISMATCH");
    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        ...valid,
        operationId: "operation_forged_calendar",
        calendarId: "calendar_forged",
        baseRemoteSnapshot: { ...snapshot, calendarId: "calendar_forged" },
      }),
    ).rejects.toThrow("CALENDAR_COMMAND_SCOPE_MISMATCH");
    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        ...valid,
        operationId: "operation_forged_baseline",
        baseRemoteSnapshot: { ...snapshot, summary: "Invented baseline" },
      }),
    ).rejects.toThrow("CALENDAR_COMMAND_PRECONDITION_MISMATCH");
    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        ...valid,
        operationId: "operation_forged_etag",
        baseRemoteEtag: "etag-forged",
      }),
    ).rejects.toThrow("CALENDAR_COMMAND_PRECONDITION_MISMATCH");

    const reorderedSnapshot = {
      status: snapshot.status,
      allDay: snapshot.allDay,
      endMs: snapshot.endMs,
      startMs: snapshot.startMs,
      summary: snapshot.summary,
      remoteEventId: snapshot.remoteEventId,
      calendarId: snapshot.calendarId,
      accountId: snapshot.accountId,
      localEventId: snapshot.localEventId,
    };
    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        ...valid,
        operationId: "operation_canonical_baseline",
        baseRemoteSnapshot: reorderedSnapshot,
      }),
    ).resolves.toBeDefined();
  });

  test("existing local-only events reject account and calendar scope drift", async () => {
    const t = convexTest(schema, modules);
    const localSnapshot = {
      ...snapshot,
      localEventId: "local_scope_001",
      remoteEventId: undefined,
    };
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_scope_create",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_scope_001",
      kind: "create",
      payload: { event: localSnapshot },
    });

    await expect(
      t.mutation(internal.desktopCalendar.enqueueOperation, {
        userId: USER,
        operationId: "operation_scope_drift",
        accountId: "account_forged",
        calendarId: "another-calendar",
        localEventId: "local_scope_001",
        kind: "update",
        payload: { patch: { summary: "Forged scope" } },
      }),
    ).rejects.toThrow("CALENDAR_COMMAND_SCOPE_MISMATCH");
  });

  test("enforces broker role and a bounded lease ownership token", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const renderer = t.withIdentity(identity("renderer"));
    const broker = t.withIdentity(identity("desktop_broker"));

    await expect(
      renderer.mutation(desktopMutation("leaseOperations"), {
        accountId: "account_001",
        leaseId: "lease_0001",
        limit: 5,
        leaseDurationMs: 30_000,
      }),
    ).rejects.toThrow("DESKTOP_BROKER_REQUIRED");

    const leased = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_0001",
      limit: 5,
      leaseDurationMs: 30_000,
    });
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({
      operationId: "operation_001",
      state: "syncing",
      leaseId: "lease_0001",
      attemptCount: 1,
    });

    await expect(
      broker.mutation(desktopMutation("recordRemoteSuccess"), {
        operationId: "operation_001",
        leaseId: "wrong_lease",
      }),
    ).rejects.toThrow("CALENDAR_OPERATION_LEASE_MISMATCH");
  });

  test("persists ambiguity and releases only the matching lease", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_0001",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    await broker.mutation(desktopMutation("recordRemoteAmbiguous"), {
      operationId: "operation_001",
      leaseId: "lease_0001",
      safeError: "network",
      retryAt: Date.now() + 1_000,
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_001"),
        )
        .unique(),
    );
    expect(row).toMatchObject({ state: "ambiguous", safeError: "network" });
    expect(row?.leaseId).toBeUndefined();
  });

  test("shutdown release restores an ambiguous reconciliation lease", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_0001",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    await broker.mutation(desktopMutation("recordRemoteAmbiguous"), {
      operationId: "operation_001",
      leaseId: "lease_0001",
      safeError: "network",
    });
    const reconciled = await broker.mutation(
      desktopMutation("leaseOperations"),
      {
        accountId: "account_001",
        leaseId: "lease_0002",
        limit: 1,
        leaseDurationMs: 30_000,
      },
    );
    expect(reconciled[0]?.leasedFromState).toBe("ambiguous");
    await broker.mutation(desktopMutation("releaseLease"), {
      leaseId: "lease_0002",
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_001"),
        )
        .unique(),
    );
    expect(row).toMatchObject({ state: "ambiguous", status: "ambiguous" });
    expect(row?.leasePreviousState).toBeUndefined();
  });

  test("release makes a pending-origin write ambiguous before it can be leased again", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_lost_receipt",
      limit: 1,
      leaseDurationMs: 30_000,
    });

    await broker.mutation(desktopMutation("releaseLease"), {
      leaseId: "lease_lost_receipt",
    });
    const reconciled = await broker.mutation(
      desktopMutation("leaseOperations"),
      {
        accountId: "account_001",
        leaseId: "lease_reconcile_lost_receipt",
        limit: 1,
        leaseDurationMs: 30_000,
      },
    );

    expect(reconciled[0]?.leasedFromState).toBe("ambiguous");
  });

  test("an expired syncing lease is reconciled as ambiguous, never replayed as pending", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_crashed_after_google",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_001"),
        )
        .unique();
      await ctx.db.patch(row!._id, {
        leaseExpiresAt: Date.now() - 1,
        nextLeaseAt: 0,
      });
    });

    const reconciled = await broker.mutation(
      desktopMutation("leaseOperations"),
      {
        accountId: "account_001",
        leaseId: "lease_after_crash",
        limit: 1,
        leaseDurationMs: 30_000,
      },
    );

    expect(reconciled[0]?.leasedFromState).toBe("ambiguous");
  });

  test("non-delete success requires a matching confirmed remote snapshot", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_0001",
      limit: 1,
      leaseDurationMs: 30_000,
    });

    await expect(
      broker.mutation(desktopMutation("recordRemoteSuccess"), {
        operationId: "operation_001",
        leaseId: "lease_0001",
      }),
    ).rejects.toThrow("CALENDAR_REMOTE_SNAPSHOT_REQUIRED");
    await expect(
      broker.mutation(desktopMutation("recordRemoteSuccess"), {
        operationId: "operation_001",
        leaseId: "lease_0001",
        remoteSnapshot: { ...snapshot, localEventId: "another-event" },
      }),
    ).rejects.toThrow("CALENDAR_REMOTE_SCOPE_MISMATCH");
  });

  test("conflict reconciliation rejects a snapshot outside the leased operation scope", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_0001",
      limit: 1,
      leaseDurationMs: 30_000,
    });

    await expect(
      broker.mutation(desktopMutation("recordRemoteConflict"), {
        operationId: "operation_001",
        leaseId: "lease_0001",
        currentRemoteSnapshot: { ...snapshot, accountId: "another-account" },
        safeError: "etag_mismatch",
      }),
    ).rejects.toThrow("CALENDAR_REMOTE_SCOPE_MISMATCH");

    const row = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_001"),
        )
        .unique(),
    );
    expect(row).toMatchObject({ state: "syncing", leaseId: "lease_0001" });
  });

  test("a confirmed delete removes the projection without inventing a baseline", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [{ remoteSnapshot: snapshot, remoteEtag: "etag-1" }],
    });
    await t.run((ctx) =>
      ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_delete_001",
        idempotencyKey: "operation_delete_001",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_event_001",
        remoteEventId: "remote-1",
        kind: "delete",
        payload: {},
        baseRemoteSnapshot: snapshot,
        baseRemoteEtag: "etag-1",
        state: "pending",
        status: "pending",
        leaseReady: true,
        nextLeaseAt: 0,
        attemptCount: 0,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_delete_001",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    await broker.mutation(desktopMutation("recordRemoteSuccess"), {
      operationId: "operation_delete_001",
      leaseId: "lease_delete_001",
      remoteReceipt: "delete-confirmed",
    });

    const event = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (q) =>
          q.eq("userId", USER).eq("localEventId", "local_event_001"),
        )
        .unique(),
    );
    expect(event).toBeNull();
  });

  test("leases create plus edits as one upload and acknowledges the whole group", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    const localSnapshot = {
      ...snapshot,
      localEventId: "local_compacted_001",
      remoteEventId: undefined,
      summary: "Lunch",
    };
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_compact_create",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_compacted_001",
      kind: "create",
      payload: { event: localSnapshot },
    });
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_compact_update",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_compacted_001",
      kind: "update",
      payload: { patch: { summary: "Dinner" } },
    });

    const leased = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_compact_001",
      limit: 5,
      leaseDurationMs: 30_000,
    });
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({
      operationId: "operation_compact_create",
      payload: { event: { summary: "Dinner" } },
      consumedOperationIds: [
        "operation_compact_create",
        "operation_compact_update",
      ],
    });

    await broker.mutation(desktopMutation("recordRemoteSuccess"), {
      operationId: "operation_compact_create",
      leaseId: "lease_compact_001",
      remoteSnapshot: {
        ...localSnapshot,
        remoteEventId: "remote-compacted-1",
        summary: "Dinner",
      },
      remoteEtag: "etag-compacted-1",
    });
    const states = await t.run(
      async (ctx) =>
        await Promise.all(
          ["operation_compact_create", "operation_compact_update"].map(
            async (operationId) =>
              (
                await ctx.db
                  .query("calendarOperations")
                  .withIndex("by_user_and_operationId", (q) =>
                    q.eq("userId", USER).eq("operationId", operationId),
                  )
                  .unique()
              )?.state,
          ),
        ),
    );
    expect(states).toEqual(["succeeded", "succeeded"]);
  });

  test("a successful local create stays one event after the next provider pull", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    const connectionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        accountId: "account_001",
        providerAccountId: "subject_001",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        selected: true,
        accountId: "account_001",
        connectionId: id,
        providerCalendarId: "primary",
      });
      return id;
    });
    const localSnapshot = {
      ...snapshot,
      localEventId: "local_created_001",
      remoteEventId: undefined,
      summary: "Created once",
    };
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_create_lifecycle_001",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_created_001",
      kind: "create",
      payload: { event: localSnapshot },
    });
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_create_lifecycle_001",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    const confirmedSnapshot = {
      ...localSnapshot,
      remoteEventId: "remote-created-001",
    };
    await broker.mutation(desktopMutation("recordRemoteSuccess"), {
      operationId: "operation_create_lifecycle_001",
      leaseId: "lease_create_lifecycle_001",
      remoteSnapshot: confirmedSnapshot,
      remoteEtag: "etag-created-1",
      remoteUpdatedAt: 2,
    });

    // Reproduce the legacy split identity that was visible as a second local
    // event even though Google contained a single provider event.
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        userId: USER,
        accountId: "account_001",
        connectionId,
        localEventId: "remote_legacy_duplicate",
        providerEventId: "remote-created-001",
        googleEventId: "remote-created-001",
        calendarId: "primary",
        summary: "Created once",
        startMs: 10,
        endMs: 20,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 2,
      });
      expect(await ctx.db.query("events").collect()).toHaveLength(2);
    });

    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      providerCalendarId: "primary",
      events: [
        {
          remoteSnapshot: {
            ...confirmedSnapshot,
            localEventId: "",
          },
          remoteEtag: "etag-created-2",
          remoteUpdatedAt: 3,
        },
      ],
    });

    const events = await t.run((ctx) => ctx.db.query("events").collect());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      localEventId: "local_created_001",
      providerEventId: "remote-created-001",
      remoteEtag: "etag-created-2",
      syncState: "synced",
    });
  });

  test("cancels create plus delete without leasing a remote call", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    const localSnapshot = {
      ...snapshot,
      localEventId: "local_cancelled_001",
      remoteEventId: undefined,
    };
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_cancel_create",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_cancelled_001",
      kind: "create",
      payload: { event: localSnapshot },
    });
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_cancel_delete",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_cancelled_001",
      kind: "delete",
      payload: {},
    });

    await expect(
      broker.mutation(desktopMutation("leaseOperations"), {
        accountId: "account_001",
        leaseId: "lease_cancel_001",
        limit: 5,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual([]);
    const states = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("calendarOperations")
          .withIndex("by_user_and_localEvent_and_createdAt", (q) =>
            q.eq("userId", USER).eq("localEventId", "local_cancelled_001"),
          )
          .collect()
      ).map((row) => row.state),
    );
    expect(states).toEqual(["cancelled", "cancelled"]);
  });

  test("persists nullable clears instead of retaining stale rendered fields", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    const baseline = {
      ...snapshot,
      localEventId: "local_clear_001",
      summary: "Old summary",
      description: "Old description",
      location: "Old location",
    };
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [{ remoteSnapshot: baseline, remoteEtag: "etag-clear-1" }],
    });
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_clear_fields",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_clear_001",
      remoteEventId: "remote-1",
      kind: "update",
      payload: {
        patch: { summary: null, description: null, location: null },
      },
      baseRemoteSnapshot: baseline,
      baseRemoteEtag: "etag-clear-1",
    });

    const event = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (q) =>
          q.eq("userId", USER).eq("localEventId", "local_clear_001"),
        )
        .unique(),
    );
    expect(event?.summary).toBeUndefined();
    expect(event?.description).toBeUndefined();
    expect(event?.location).toBeUndefined();
  });

  test("a remote page rebases pending intent and commits its cursor separately", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));

    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [
        {
          remoteSnapshot: { ...snapshot, location: "Room B" },
          remoteEtag: "etag-2",
          remoteUpdatedAt: 2,
        },
      ],
    });
    await broker.mutation(desktopMutation("completeRemoteSync"), {
      accountId: "account_001",
      calendarId: "primary",
      syncToken: "sync-2",
    });
    const leased = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_rebased_001",
      limit: 1,
      leaseDurationMs: 30_000,
    });

    const result = await t.run(async (ctx) => ({
      event: await ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (q) =>
          q.eq("userId", USER).eq("localEventId", "local_event_001"),
        )
        .unique(),
      calendar: await ctx.db
        .query("calendars")
        .withIndex("by_user_and_googleCalendarId", (q) =>
          q.eq("userId", USER).eq("googleCalendarId", "primary"),
        )
        .unique(),
    }));
    expect(result.event).toMatchObject({
      summary: "Local",
      location: "Room B",
      remoteEtag: "etag-2",
      syncState: "pending",
    });
    expect(result.calendar?.syncToken).toBe("sync-2");
    expect(leased[0]).toMatchObject({
      baseRemoteEtag: "etag-1",
      uploadBaseRemoteEtag: "etag-2",
      uploadBaseRemoteSnapshot: { location: "Room B" },
    });
  });

  test("an overlapping pull marks the intended operation as a durable conflict", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [{ remoteSnapshot: snapshot, remoteEtag: "etag-1" }],
    });
    await seedPending(t);

    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [
        {
          remoteSnapshot: { ...snapshot, summary: "Changed remotely" },
          remoteEtag: "etag-2",
        },
      ],
    });

    const result = await t.run(async (ctx) => ({
      operation: await ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_001"),
        )
        .unique(),
      event: await ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (q) =>
          q.eq("userId", USER).eq("localEventId", "local_event_001"),
        )
        .unique(),
    }));
    expect(result.operation).toMatchObject({
      state: "conflict",
      safeError: "remote_conflict",
    });
    expect(result.event).toMatchObject({
      summary: "Local",
      remoteEtag: "etag-2",
      syncState: "conflict",
    });
  });

  test("rejects an active chain beyond the explicit projection bound", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await t.run(async (ctx) => {
      for (let index = 0; index < 129; index += 1) {
        const operationId = `operation_bound_${String(index).padStart(3, "0")}`;
        await ctx.db.insert("calendarOperations", {
          userId: USER,
          operationId,
          idempotencyKey: operationId,
          accountId: "account_001",
          calendarId: "primary",
          localEventId: "local_event_bound_001",
          remoteEventId: "remote-bound-1",
          kind: "update",
          payload: { patch: { summary: `Local ${index}` } },
          baseRemoteSnapshot: {
            ...snapshot,
            localEventId: "local_event_bound_001",
            remoteEventId: "remote-bound-1",
          },
          baseRemoteEtag: "etag-bound-1",
          predecessorOperationId:
            index === 0
              ? undefined
              : `operation_bound_${String(index - 1).padStart(3, "0")}`,
          state: "pending",
          status: "pending",
          attemptCount: 0,
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    await expect(
      broker.mutation(desktopMutation("applyRemotePage"), {
        accountId: "account_001",
        calendarId: "primary",
        events: [
          {
            remoteSnapshot: {
              ...snapshot,
              localEventId: "local_event_bound_001",
              remoteEventId: "remote-bound-1",
            },
            remoteEtag: "etag-bound-2",
          },
        ],
      }),
    ).rejects.toThrow("CALENDAR_ACTIVE_CHAIN_TOO_LARGE");
  });

  test("terminal history does not count against the active projection bound", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await t.run(async (ctx) => {
      for (let index = 0; index < 260; index += 1) {
        const operationId = `operation_terminal_${String(index).padStart(3, "0")}`;
        await ctx.db.insert("calendarOperations", {
          userId: USER,
          operationId,
          idempotencyKey: operationId,
          accountId: "account_001",
          calendarId: "primary",
          localEventId: "local_event_history_001",
          remoteEventId: "remote-history-1",
          kind: "update",
          payload: { patch: { summary: `Historical ${index}` } },
          state: "succeeded",
          status: "succeeded",
          attemptCount: 1,
          createdAt: index,
          updatedAt: index,
        });
      }
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_history_active",
        idempotencyKey: "operation_history_active",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_event_history_001",
        remoteEventId: "remote-history-1",
        kind: "update",
        payload: { patch: { summary: "Current local intent" } },
        baseRemoteSnapshot: {
          ...snapshot,
          localEventId: "local_event_history_001",
          remoteEventId: "remote-history-1",
        },
        baseRemoteEtag: "etag-history-1",
        state: "pending",
        status: "pending",
        attemptCount: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });

    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [
        {
          remoteSnapshot: {
            ...snapshot,
            localEventId: "local_event_history_001",
            remoteEventId: "remote-history-1",
          },
          remoteEtag: "etag-history-2",
        },
      ],
    });
    const event = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (q) =>
          q.eq("userId", USER).eq("localEventId", "local_event_history_001"),
        )
        .unique(),
    );
    expect(event?.summary).toBe("Current local intent");
  });

  test("remote deletion never scans or rewrites terminal operation history", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    const remote = {
      ...snapshot,
      localEventId: "local_delete_history_001",
      remoteEventId: "remote-delete-history-1",
    };
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [{ remoteSnapshot: remote, remoteEtag: "etag-delete-1" }],
    });
    const terminalId = await t.run(async (ctx) => {
      let duplicateId;
      for (let index = 0; index < 260; index += 1) {
        const operationId =
          index === 259
            ? "operation_delete_active"
            : `operation_delete_history_${String(index).padStart(3, "0")}`;
        const id = await ctx.db.insert("calendarOperations", {
          userId: USER,
          operationId,
          idempotencyKey: `${operationId}_terminal_${index}`,
          accountId: "account_001",
          calendarId: "primary",
          localEventId: "local_delete_history_001",
          remoteEventId: "remote-delete-history-1",
          kind: "update",
          payload: { patch: { summary: `Historical ${index}` } },
          state: "succeeded",
          status: "succeeded",
          attemptCount: 1,
          createdAt: index,
          updatedAt: index,
        });
        if (index === 259) duplicateId = id;
      }
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_delete_active",
        idempotencyKey: "operation_delete_active_pending",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_delete_history_001",
        remoteEventId: "remote-delete-history-1",
        kind: "update",
        payload: { patch: { summary: "Pending local intent" } },
        baseRemoteSnapshot: remote,
        baseRemoteEtag: "etag-delete-1",
        uploadBaseRemoteSnapshot: remote,
        uploadBaseRemoteEtag: "etag-delete-1",
        state: "pending",
        status: "pending",
        leaseReady: true,
        nextLeaseAt: 0,
        attemptCount: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      return duplicateId!;
    });

    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [
        {
          remoteSnapshot: remote,
          remoteEtag: "etag-delete-2",
          deleted: true,
        },
      ],
    });
    const terminal = await t.run((ctx) => ctx.db.get(terminalId));
    expect(terminal).toMatchObject({ state: "succeeded", status: "succeeded" });
  });

  test("blocked operations beyond the old prefilter cannot starve an eligible event", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const localEventId = `local_blocked_${suffix}`;
      const predecessorOperationId = `operation_conflict_${suffix}`;
      await t.run((ctx) =>
        ctx.db.insert("calendarOperations", {
          userId: USER,
          operationId: predecessorOperationId,
          idempotencyKey: predecessorOperationId,
          accountId: "account_001",
          calendarId: "primary",
          localEventId,
          kind: "create",
          payload: {
            event: {
              ...snapshot,
              localEventId,
              remoteEventId: undefined,
            },
          },
          state: "conflict",
          status: "failed",
          attemptCount: 0,
          createdAt: index,
          updatedAt: index,
        }),
      );
      await t.mutation(internal.desktopCalendar.enqueueOperation, {
        userId: USER,
        operationId: `operation_blocked_${suffix}`,
        accountId: "account_001",
        calendarId: "primary",
        localEventId,
        kind: "create",
        payload: {
          event: {
            ...snapshot,
            localEventId,
            remoteEventId: undefined,
          },
        },
        predecessorOperationId,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_independent_ready",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_independent_ready",
      kind: "create",
      payload: {
        event: {
          ...snapshot,
          localEventId: "local_independent_ready",
          remoteEventId: undefined,
        },
      },
    });

    const leased = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_independent_ready",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    expect(leased).toHaveLength(1);
    expect(leased[0]?.operationId).toBe("operation_independent_ready");
  });

  test("shares one transaction-safe readiness repair budget fairly across states", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await t.run(async (ctx) => {
      for (const state of ["pending", "ambiguous", "syncing"] as const) {
        for (let index = 0; index < 40; index += 1) {
          const suffix = `${state}_${String(index).padStart(2, "0")}`;
          const localEventId = `local_budget_${suffix}`;
          const predecessorOperationId = `operation_budget_conflict_${suffix}`;
          await ctx.db.insert("calendarOperations", {
            userId: USER,
            operationId: predecessorOperationId,
            idempotencyKey: predecessorOperationId,
            accountId: "account_001",
            calendarId: "primary",
            localEventId,
            kind: "create",
            payload: {
              event: { ...snapshot, localEventId, remoteEventId: undefined },
            },
            state: "conflict",
            status: "failed",
            leaseReady: false,
            nextLeaseAt: 0,
            attemptCount: 0,
            createdAt: index * 2,
            updatedAt: index * 2,
          });
          await ctx.db.insert("calendarOperations", {
            userId: USER,
            operationId: `operation_budget_candidate_${suffix}`,
            idempotencyKey: `operation_budget_candidate_${suffix}`,
            accountId: "account_001",
            calendarId: "primary",
            localEventId,
            kind: "create",
            payload: {
              event: { ...snapshot, localEventId, remoteEventId: undefined },
            },
            predecessorOperationId,
            state,
            status: state === "ambiguous" ? "ambiguous" : "pending",
            leaseReady: true,
            nextLeaseAt: 0,
            attemptCount: 1,
            createdAt: index * 2 + 1,
            updatedAt: index * 2 + 1,
          });
        }
      }
    });

    const leased = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_bounded_repairs",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    expect(leased).toEqual([]);
    const repairedByState = await t.run(async (ctx) => {
      const rows = await ctx.db.query("calendarOperations").collect();
      return rows
        .filter(
          (row) =>
            row.operationId?.startsWith("operation_budget_candidate_") &&
            row.leaseReady === false,
        )
        .reduce<Record<string, number>>((counts, row) => {
          counts[row.state!] = (counts[row.state!] ?? 0) + 1;
          return counts;
        }, {});
    });
    expect(repairedByState).toEqual({
      pending: 32,
      ambiguous: 32,
      syncing: 32,
    });
  });

  test("demotes stale non-leaders in bounded batches until eligible work is reachable", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await t.run(async (ctx) => {
      for (let index = 0; index < 65; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const localEventId = `local_stale_nonleader_${suffix}`;
        if (index % 2 === 1) {
          await ctx.db.insert("calendarOperations", {
            userId: USER,
            operationId: `operation_hidden_leader_${suffix}`,
            idempotencyKey: `operation_hidden_leader_${suffix}`,
            accountId: "account_001",
            calendarId: "primary",
            localEventId,
            kind: "create",
            payload: {
              event: { ...snapshot, localEventId, remoteEventId: undefined },
            },
            state: "pending",
            status: "pending",
            leaseReady: false,
            nextLeaseAt: 0,
            attemptCount: 0,
            createdAt: index * 3,
            updatedAt: index * 3,
          });
        }
        await ctx.db.insert("calendarOperations", {
          userId: USER,
          operationId: `operation_stale_nonleader_${suffix}`,
          idempotencyKey: `operation_stale_nonleader_${suffix}`,
          accountId: "account_001",
          calendarId: "primary",
          localEventId,
          kind: index % 2 === 0 ? "create" : "update",
          payload:
            index % 2 === 0
              ? undefined
              : { patch: { summary: `Compacted ${index}` } },
          state: "pending",
          status: "pending",
          leaseReady: true,
          nextLeaseAt: 0,
          attemptCount: 0,
          createdAt: index * 3 + 1,
          updatedAt: index * 3 + 1,
        });
      }
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_ready_after_nonleaders",
        idempotencyKey: "operation_ready_after_nonleaders",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_ready_after_nonleaders",
        kind: "create",
        payload: {
          event: {
            ...snapshot,
            localEventId: "local_ready_after_nonleaders",
            remoteEventId: undefined,
          },
        },
        state: "pending",
        status: "pending",
        leaseReady: true,
        nextLeaseAt: 0,
        attemptCount: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });
    const repairedCount = () =>
      t.run(async (ctx) => {
        const rows = await ctx.db.query("calendarOperations").collect();
        return rows.filter(
          (row) =>
            row.operationId?.startsWith("operation_stale_nonleader_") &&
            row.leaseReady === false,
        ).length;
      });

    for (const [attempt, expectedRepairs] of [
      [1, 32],
      [2, 64],
    ] as const) {
      await expect(
        broker.mutation(desktopMutation("leaseOperations"), {
          accountId: "account_001",
          leaseId: `lease_nonleader_page_${attempt}`,
          limit: 1,
          leaseDurationMs: 30_000,
        }),
      ).resolves.toEqual([]);
      await expect(repairedCount()).resolves.toBe(expectedRepairs);
    }
    const leased = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_ready_after_nonleaders",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    expect(leased[0]?.operationId).toBe("operation_ready_after_nonleaders");
    await expect(repairedCount()).resolves.toBe(65);
  });

  test("repairs a large stale-ready prefix in bounded calls without starvation", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await t.run(async (ctx) => {
      for (let index = 0; index < 129; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const localEventId = `local_stale_ready_${suffix}`;
        const predecessorOperationId = `operation_stale_conflict_${suffix}`;
        await ctx.db.insert("calendarOperations", {
          userId: USER,
          operationId: predecessorOperationId,
          idempotencyKey: predecessorOperationId,
          accountId: "account_001",
          calendarId: "primary",
          localEventId,
          kind: "create",
          payload: {
            event: { ...snapshot, localEventId, remoteEventId: undefined },
          },
          state: "conflict",
          status: "failed",
          leaseReady: false,
          nextLeaseAt: 0,
          attemptCount: 0,
          createdAt: index * 2,
          updatedAt: index * 2,
        });
        await ctx.db.insert("calendarOperations", {
          userId: USER,
          operationId: `operation_stale_ready_${suffix}`,
          idempotencyKey: `operation_stale_ready_${suffix}`,
          accountId: "account_001",
          calendarId: "primary",
          localEventId,
          kind: "create",
          payload: {
            event: { ...snapshot, localEventId, remoteEventId: undefined },
          },
          predecessorOperationId,
          state: "pending",
          status: "pending",
          leaseReady: true,
          nextLeaseAt: 0,
          attemptCount: 0,
          createdAt: index * 2 + 1,
          updatedAt: index * 2 + 1,
        });
      }
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_ready_after_stale",
        idempotencyKey: "operation_ready_after_stale",
        accountId: "account_001",
        calendarId: "primary",
        localEventId: "local_ready_after_stale",
        kind: "create",
        payload: {
          event: {
            ...snapshot,
            localEventId: "local_ready_after_stale",
            remoteEventId: undefined,
          },
        },
        state: "pending",
        status: "pending",
        leaseReady: true,
        nextLeaseAt: 0,
        attemptCount: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
    });

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        broker.mutation(desktopMutation("leaseOperations"), {
          accountId: "account_001",
          leaseId: `lease_repair_page_${attempt}`,
          limit: 1,
          leaseDurationMs: 30_000,
        }),
      ).resolves.toEqual([]);
    }
    const leased = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_ready_after_stale",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    expect(leased[0]?.operationId).toBe("operation_ready_after_stale");
    const repaired = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_stale_ready_000"),
        )
        .unique(),
    );
    expect(repaired?.leaseReady).toBe(false);
  });

  test("broker sync state is role-scoped and wakes on durable pending work", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const renderer = t.withIdentity(identity("renderer"));
    const broker = t.withIdentity(identity("desktop_broker"));
    await t.run(async (ctx) => {
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        providerCalendarId: "primary",
        accountId: "account_001",
        selected: true,
        syncToken: "sync-old",
      });
    });

    await expect(
      renderer.query(desktopQuery("syncState"), { accountId: "account_001" }),
    ).rejects.toThrow("DESKTOP_BROKER_REQUIRED");
    await expect(
      broker.query(desktopQuery("syncState"), { accountId: "account_001" }),
    ).resolves.toMatchObject({
      calendars: [
        {
          accountId: "account_001",
          calendarId: "primary",
          syncToken: "sync-old",
        },
      ],
      pendingCount: 1,
    });
  });

  test("calendar-list reconciliation removes inaccessible calendars from pull scheduling", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: "account_001",
      calendars: [
        { id: "primary", primary: true, writable: true },
        { id: "revoked", writable: true },
      ],
    });
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: "account_001",
      calendars: [{ id: "primary", primary: true, writable: true }],
    });

    const state = await broker.query(desktopQuery("syncState"), {
      accountId: "account_001",
    });
    expect(state.calendars.map((calendar) => calendar.calendarId)).toEqual([
      "primary",
    ]);
  });

  test("heartbeat, retry, and permanent failure preserve exact lease ownership", async () => {
    const t = convexTest(schema, modules);
    await seedPending(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_heartbeat_001",
      limit: 1,
      leaseDurationMs: 5_000,
    });
    const before = await t.run((ctx) =>
      ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (q) =>
          q.eq("userId", USER).eq("operationId", "operation_001"),
        )
        .unique(),
    );
    await broker.mutation(desktopMutation("heartbeatLease"), {
      leaseId: "lease_heartbeat_001",
      leaseDurationMs: 30_000,
    });
    const heartbeated = await t.run((ctx) => ctx.db.get(before!._id));
    expect(heartbeated!.leaseExpiresAt).toBeGreaterThan(
      before!.leaseExpiresAt!,
    );

    await broker.mutation(desktopMutation("recordRemoteRetry"), {
      operationId: "operation_001",
      leaseId: "lease_heartbeat_001",
      safeError: "rate-limit",
      retryAt: Date.now() + 60_000,
    });
    const retried = await t.run((ctx) => ctx.db.get(before!._id));
    expect(retried).toMatchObject({
      state: "pending",
      safeError: "rate-limit",
    });

    await t.run((ctx) =>
      ctx.db.patch(before!._id, { nextLeaseAt: 0, retryAt: undefined }),
    );

    await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: "account_001",
      leaseId: "lease_failure_001",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    await broker.mutation(desktopMutation("recordRemoteFailure"), {
      operationId: "operation_001",
      leaseId: "lease_failure_001",
      safeError: "validation",
    });
    const failed = await t.run((ctx) => ctx.db.get(before!._id));
    expect(failed).toMatchObject({ state: "failed", safeError: "validation" });
    expect(failed?.leaseId).toBeUndefined();
  });

  test("a 410 full generation keeps pending intent while replacing only that calendar baseline", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: "account_001",
      calendars: [
        {
          id: "primary",
          summary: "Primary",
          primary: true,
          writable: true,
          accessRole: "owner",
        },
        {
          id: "other",
          summary: "Other",
          writable: true,
          accessRole: "owner",
        },
      ],
    });
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      events: [{ remoteSnapshot: snapshot, remoteEtag: "etag-1" }],
    });
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_full_sync_001",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_event_001",
      remoteEventId: "remote-1",
      kind: "update",
      payload: { patch: { summary: "Pending survives" } },
      baseRemoteSnapshot: snapshot,
      baseRemoteEtag: "etag-1",
    });
    const generation = await broker.mutation(
      desktopMutation("beginRemoteFullSync"),
      { accountId: "account_001", calendarId: "primary" },
    );
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: "account_001",
      calendarId: "primary",
      fullSyncGeneration: generation.generation,
      events: [
        {
          remoteSnapshot: { ...snapshot, location: "Remote room" },
          remoteEtag: "etag-2",
        },
      ],
    });
    await expect(
      broker.mutation(desktopMutation("completeRemoteSync"), {
        accountId: "account_001",
        calendarId: "primary",
        fullSyncGeneration: generation.generation,
        syncToken: "sync-new",
      }),
    ).resolves.toMatchObject({ done: true });
    const event = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (q) =>
          q.eq("userId", USER).eq("localEventId", "local_event_001"),
        )
        .unique(),
    );
    expect(event).toMatchObject({
      summary: "Pending survives",
      location: "Remote room",
      remoteEtag: "etag-2",
      syncGeneration: generation.generation,
    });
    const state = await broker.query(desktopQuery("syncState"), {
      accountId: "account_001",
    });
    expect(
      state.calendars.find((entry: any) => entry.calendarId === "primary"),
    ).toMatchObject({ syncToken: "sync-new" });
  });

  test("a full sync never treats a concurrent local create as remotely deleted", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(identity("desktop_broker"));
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: "account_001",
      calendars: [
        {
          id: "primary",
          summary: "Primary",
          primary: true,
          writable: true,
          accessRole: "owner",
        },
      ],
    });
    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_during_full_sync_001",
      accountId: "account_001",
      calendarId: "primary",
      localEventId: "local_during_full_sync_001",
      kind: "create",
      payload: {
        event: {
          ...snapshot,
          localEventId: "local_during_full_sync_001",
          remoteEventId: undefined,
          summary: "Publish after pull",
        },
      },
    });
    const generation = await broker.mutation(
      desktopMutation("beginRemoteFullSync"),
      { accountId: "account_001", calendarId: "primary" },
    );

    await expect(
      broker.mutation(desktopMutation("completeRemoteSync"), {
        accountId: "account_001",
        calendarId: "primary",
        fullSyncGeneration: generation.generation,
        syncToken: "sync-after-local-create",
      }),
    ).resolves.toMatchObject({ done: false });
    await expect(
      broker.mutation(desktopMutation("completeRemoteSync"), {
        accountId: "account_001",
        calendarId: "primary",
        fullSyncGeneration: generation.generation,
        syncToken: "sync-after-local-create",
      }),
    ).resolves.toMatchObject({ done: true });

    const result = await t.run(async (ctx) => ({
      event: await ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (query) =>
          query
            .eq("userId", USER)
            .eq("localEventId", "local_during_full_sync_001"),
        )
        .unique(),
      operation: await ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (query) =>
          query
            .eq("userId", USER)
            .eq("operationId", "operation_during_full_sync_001"),
        )
        .unique(),
    }));
    expect(result.event).toMatchObject({
      summary: "Publish after pull",
      syncState: "pending",
      syncGeneration: generation.generation,
    });
    expect(result.operation).toMatchObject({
      state: "pending",
      leaseReady: true,
    });
  });
});
