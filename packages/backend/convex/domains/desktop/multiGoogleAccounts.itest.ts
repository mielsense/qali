/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";

import { api, internal } from "../../_generated/api";
import schema from "../../schema";
import { LOCAL_AUTH_ISSUERS } from "./identity";

const modules = import.meta.glob("../../**/*.ts");
const USER = "qali-local-user";
const ACCOUNT_A = "gacc_AXOeTQcAOOzuZDa1gSo7yzrwYsizbVepkObxz3dP8d4";
const ACCOUNT_B = "gacc_vPanDgJgpx9miW_aW_wT4M4Mo54S6dzdU8RZ30ltVwM";
const CALENDAR_A = "gcal__5F2wr5WnjKzUjzhqPIPAJlZJdhJAjQnNye2bgDS0yY";
const CALENDAR_B = "gcal_K32EPI884avnMbFHbFbVovpdC_p3njG4zC9AzDf7wLg";
const OTHER_A = "gcal_ldIPwAWHwNajtP-fNrmTPcBx76fyLYphIi8OKAKqxss";

function brokerIdentity() {
  return {
    issuer: LOCAL_AUTH_ISSUERS.test,
    subject: USER,
    tokenIdentifier: `${LOCAL_AUTH_ISSUERS.test}|${USER}`,
    email: "local@qali.app",
    name: "Qali User",
    role: "desktop_broker" as const,
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

describe("desktop multi-Google identity", () => {
  test("no-identity legacy migration is a no-op on a fresh database", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(brokerIdentity());

    await expect(
      broker.mutation(desktopMutation("migrateLegacyGoogleData"), {}),
    ).resolves.toEqual({ done: true, migrated: 0 });

    await t.run(async (ctx) => {
      expect(await ctx.db.query("calendarConnections").collect()).toEqual([]);
    });
  });

  test("two accounts can each sync Google's raw primary calendar without collision", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(brokerIdentity());

    await broker.mutation(desktopMutation("attachGoogleAccount"), {
      accountId: ACCOUNT_A,
      providerAccountId: "sub-a",
      accountEmail: "a@example.com",
    });
    await broker.mutation(desktopMutation("attachGoogleAccount"), {
      accountId: ACCOUNT_B,
      providerAccountId: "sub-b",
      accountEmail: "b@example.com",
    });
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: ACCOUNT_A,
      calendars: [{ id: "primary", primary: true, writable: true }],
    });
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: ACCOUNT_B,
      calendars: [{ id: "primary", primary: true, writable: true }],
    });

    await t.run(async (ctx) => {
      const connections = await ctx.db
        .query("calendarConnections")
        .withIndex("by_user", (query) => query.eq("userId", USER))
        .collect();
      expect(connections).toHaveLength(2);
      expect(
        connections.map((row) => [row.accountId, row.providerAccountId]).sort(),
      ).toEqual([
        [ACCOUNT_A, "sub-a"],
        [ACCOUNT_B, "sub-b"],
      ]);
      const calendars = await ctx.db
        .query("calendars")
        .withIndex("by_user", (query) => query.eq("userId", USER))
        .collect();
      expect(calendars).toHaveLength(2);
      expect(
        calendars
          .map((row) => [row.googleCalendarId, row.providerCalendarId])
          .sort(),
      ).toEqual(
        [
          [CALENDAR_A, "primary"],
          [CALENDAR_B, "primary"],
        ].sort(),
      );
    });

    await expect(
      broker.query(desktopQuery("syncState"), { accountId: ACCOUNT_A }),
    ).resolves.toMatchObject({
      calendars: [
        {
          accountId: ACCOUNT_A,
          calendarId: CALENDAR_A,
          providerCalendarId: "primary",
        },
      ],
    });
  });

  test("rejects an account id that is not derived from the authenticated Google subject", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(brokerIdentity());
    await expect(
      broker.mutation(desktopMutation("attachGoogleAccount"), {
        accountId: ACCOUNT_B,
        providerAccountId: "sub-a",
      }),
    ).rejects.toThrow("GOOGLE_ACCOUNT_ID_MISMATCH");
  });

  test("a proven account claims the single legacy connection without replacing its id", async () => {
    const t = convexTest(schema, modules);
    const legacyConnectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const broker = t.withIdentity(brokerIdentity());
    const attached = await broker.mutation(
      desktopMutation("attachGoogleAccount"),
      {
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
      },
    );
    expect(attached).toMatchObject({
      connectionId: legacyConnectionId,
      claimedLegacy: true,
    });
  });

  test("a proven account can reclaim a detached legacy connection without replacing its id", async () => {
    const t = convexTest(schema, modules);
    const legacyConnectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "paused",
        lastError: "legacy_identity_required",
        legacyMigrationState: "detached",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const broker = t.withIdentity(brokerIdentity());
    const attached = await broker.mutation(
      desktopMutation("attachGoogleAccount"),
      {
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
      },
    );

    expect(attached).toEqual({
      connectionId: legacyConnectionId,
      claimedLegacy: true,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(legacyConnectionId)).toMatchObject({
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
        status: "active",
        legacyMigrationState: "claimed",
      });
    });
  });

  test("remote pages and move leases keep local and provider calendar identities distinct", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(brokerIdentity());
    await broker.mutation(desktopMutation("attachGoogleAccount"), {
      accountId: ACCOUNT_A,
      providerAccountId: "sub-a",
    });
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: ACCOUNT_A,
      calendars: [
        { id: "primary", primary: true, writable: true },
        { id: "other", writable: true },
      ],
    });
    const snapshot = {
      localEventId: "remote_local_001",
      accountId: ACCOUNT_A,
      calendarId: CALENDAR_A,
      providerCalendarId: "primary",
      remoteEventId: "same-google-event-id",
      startMs: 1_000,
      endMs: 2_000,
      allDay: false,
      status: "confirmed",
    };
    await broker.mutation(desktopMutation("applyRemotePage"), {
      accountId: ACCOUNT_A,
      calendarId: CALENDAR_A,
      providerCalendarId: "primary",
      events: [{ remoteSnapshot: snapshot, remoteEtag: "etag-1" }],
    });

    await t.mutation(internal.desktopCalendar.enqueueOperation, {
      userId: USER,
      operationId: "operation_move_identity_001",
      accountId: ACCOUNT_A,
      calendarId: CALENDAR_A,
      localEventId: "remote_local_001",
      remoteEventId: "same-google-event-id",
      kind: "move",
      payload: { destinationCalendarId: OTHER_A },
      baseRemoteSnapshot: snapshot,
      baseRemoteEtag: "etag-1",
    });
    const [leased] = await broker.mutation(desktopMutation("leaseOperations"), {
      accountId: ACCOUNT_A,
      leaseId: "lease_move_identity_001",
      limit: 1,
      leaseDurationMs: 30_000,
    });
    expect(leased).toMatchObject({
      calendarId: CALENDAR_A,
      providerCalendarId: "primary",
      providerEventId: "same-google-event-id",
      payload: {
        destinationCalendarId: OTHER_A,
        destinationProviderCalendarId: "other",
      },
    });
    await t.run(async (ctx) => {
      const event = await ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (query) =>
          query.eq("userId", USER).eq("localEventId", "remote_local_001"),
        )
        .unique();
      expect(event).toMatchObject({
        calendarId: OTHER_A,
        connectionId: expect.any(String),
        providerEventId: "same-google-event-id",
      });
    });
  });

  test("stable accounts require raw provider calendar identity on remote sync writes", async () => {
    const t = convexTest(schema, modules);
    const broker = t.withIdentity(brokerIdentity());
    await broker.mutation(desktopMutation("attachGoogleAccount"), {
      accountId: ACCOUNT_A,
      providerAccountId: "sub-a",
    });
    await broker.mutation(desktopMutation("applyRemoteCalendars"), {
      accountId: ACCOUNT_A,
      calendars: [{ id: "primary", primary: true, writable: true }],
    });
    const remoteSnapshot = {
      localEventId: "remote_missing_provider_001",
      accountId: ACCOUNT_A,
      calendarId: CALENDAR_A,
      remoteEventId: "remote-missing-provider",
      startMs: 1_000,
      endMs: 2_000,
      allDay: false,
      status: "confirmed",
    };

    await expect(
      broker.mutation(desktopMutation("applyRemotePage"), {
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        events: [{ remoteSnapshot }],
      }),
    ).rejects.toThrow("GOOGLE_PROVIDER_CALENDAR_ID_REQUIRED");
    await expect(
      broker.mutation(desktopMutation("beginRemoteFullSync"), {
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
      }),
    ).rejects.toThrow("GOOGLE_PROVIDER_CALENDAR_ID_REQUIRED");
    await expect(
      broker.mutation(desktopMutation("completeRemoteSync"), {
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        syncToken: "next-page-token",
      }),
    ).rejects.toThrow("GOOGLE_PROVIDER_CALENDAR_ID_REQUIRED");
  });

  test("paged migration rekeys a claimed legacy graph without resetting durable work", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      for (const [id, color] of [
        ["primary", "event-1"],
        ["other", "event-2"],
      ] as const) {
        await ctx.db.insert("calendars", {
          userId: USER,
          googleCalendarId: id,
          providerCalendarId: id,
          accountId: "google-local-account",
          selected: id === "primary",
          colorOverride: color,
          syncToken: `cursor-${id}`,
          syncGeneration: 7,
        });
      }
      const legacySnapshot = {
        localEventId: "legacy_local_001",
        accountId: "google-local-account",
        calendarId: "primary",
        remoteEventId: "remote-legacy-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
      };
      await ctx.db.insert("events", {
        userId: USER,
        localEventId: "legacy_local_001",
        accountId: "google-local-account",
        calendarId: "primary",
        googleEventId: "remote-legacy-1",
        providerEventId: "remote-legacy-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1,
        remoteSnapshot: legacySnapshot,
        syncState: "pending",
        syncGeneration: 7,
      });
      await ctx.db.insert("recurringSeries", {
        userId: USER,
        calendarId: "primary",
        googleEventId: "series-1",
        providerEventId: "series-1",
        recurrence: ["RRULE:FREQ=WEEKLY"],
        sourceUpdatedMs: 1,
      });
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        operationId: "operation_legacy_move_001",
        idempotencyKey: "idempotency-kept",
        accountId: "google-local-account",
        calendarId: "primary",
        providerCalendarId: "primary",
        localEventId: "legacy_local_001",
        remoteEventId: "remote-legacy-1",
        providerEventId: "remote-legacy-1",
        kind: "move",
        payload: { destinationCalendarId: "other" },
        baseRemoteSnapshot: legacySnapshot,
        uploadBaseRemoteSnapshot: legacySnapshot,
        state: "syncing",
        status: "pending",
        leaseReady: true,
        nextLeaseAt: 9_000,
        leaseId: "lease-kept",
        leaseExpiresAt: 9_000,
        attemptCount: 3,
        createdAt: 2,
        updatedAt: 3,
      });
      return { connectionId };
    });
    const broker = t.withIdentity(brokerIdentity());
    await broker.mutation(desktopMutation("attachGoogleAccount"), {
      accountId: ACCOUNT_A,
      providerAccountId: "sub-a",
    });
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        {
          accountId: ACCOUNT_A,
          providerAccountId: "sub-a",
          cursor,
        },
      );
      cursor = result.cursor;
      if (result.done) break;
    }
    expect(cursor).toBeUndefined();

    // A caller that loses its terminal cursor can safely restart the whole
    // migration without corrupting already-canonical rows.
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        {
          accountId: ACCOUNT_A,
          providerAccountId: "sub-a",
          cursor,
        },
      );
      cursor = result.cursor;
      if (result.done) break;
    }
    expect(cursor).toBeUndefined();

    let auditCursor: string | undefined;
    let violations = 0;
    for (let page = 0; page < 10; page += 1) {
      const audit = await broker.query(
        desktopQuery("auditGoogleAccountMigration"),
        { accountId: ACCOUNT_A, cursor: auditCursor },
      );
      violations += audit.violations;
      auditCursor = audit.cursor;
      if (audit.done) break;
    }
    expect(auditCursor).toBeUndefined();
    expect(violations).toBe(0);

    await t.run(async (ctx) => {
      const connection = await ctx.db.get(seeded.connectionId);
      expect(connection).toMatchObject({
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
        legacyMigrationState: "complete",
      });
      const calendars = await ctx.db
        .query("calendars")
        .withIndex("by_user", (query) => query.eq("userId", USER))
        .collect();
      expect(calendars).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            googleCalendarId: CALENDAR_A,
            providerCalendarId: "primary",
            colorOverride: "event-1",
            selected: true,
            syncToken: "cursor-primary",
            syncGeneration: 7,
          }),
          expect.objectContaining({
            googleCalendarId: OTHER_A,
            providerCalendarId: "other",
            colorOverride: "event-2",
            selected: false,
            syncToken: "cursor-other",
            syncGeneration: 7,
          }),
        ]),
      );
      expect(await ctx.db.query("events").unique()).toMatchObject({
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        connectionId: seeded.connectionId,
        remoteSnapshot: {
          accountId: ACCOUNT_A,
          calendarId: CALENDAR_A,
          providerCalendarId: "primary",
        },
      });
      expect(await ctx.db.query("recurringSeries").unique()).toMatchObject({
        calendarId: CALENDAR_A,
        connectionId: seeded.connectionId,
      });
      expect(await ctx.db.query("calendarOperations").unique()).toMatchObject({
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        connectionId: seeded.connectionId,
        providerCalendarId: "primary",
        idempotencyKey: "idempotency-kept",
        state: "syncing",
        leaseId: "lease-kept",
        leaseExpiresAt: 9_000,
        attemptCount: 3,
        payload: {
          destinationCalendarId: OTHER_A,
          destinationProviderCalendarId: "other",
        },
      });
    });
  });

  test("migration audit reports legacy rows left outside the claimed graph", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
        status: "active",
        legacyMigrationState: "complete",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "late-legacy-calendar",
        selected: true,
      }),
    );
    const broker = t.withIdentity(brokerIdentity());
    let cursor: string | undefined;
    let violations = 0;
    for (let page = 0; page < 10; page += 1) {
      const audit = await broker.query(
        desktopQuery("auditGoogleAccountMigration"),
        { accountId: ACCOUNT_A, cursor },
      );
      cursor = audit.cursor;
      violations += audit.violations;
      if (audit.done) break;
    }

    expect(cursor).toBeUndefined();
    expect(violations).toBe(1);
  });

  test("late unassigned rows are quarantined without guessing a Google account", async () => {
    const t = convexTest(schema, modules);
    const { accountConnectionId, legacyCalendarId } = await t.run(
      async (ctx) => {
        const accountConnectionId = await ctx.db.insert("calendarConnections", {
          userId: USER,
          provider: "google",
          accountId: ACCOUNT_A,
          providerAccountId: "sub-a",
          status: "active",
          legacyMigrationState: "complete",
          createdAt: 1,
          updatedAt: 1,
        });
        const legacyCalendarId = await ctx.db.insert("calendars", {
          userId: USER,
          googleCalendarId: "late-legacy-calendar",
          selected: true,
        });
        return { accountConnectionId, legacyCalendarId };
      },
    );
    const broker = t.withIdentity(brokerIdentity());
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        { cursor },
      );
      cursor = result.cursor;
      if (result.done) break;
    }

    let auditCursor: string | undefined;
    let violations = 0;
    for (let page = 0; page < 10; page += 1) {
      const audit = await broker.query(
        desktopQuery("auditGoogleAccountMigration"),
        { accountId: ACCOUNT_A, cursor: auditCursor },
      );
      auditCursor = audit.cursor;
      violations += audit.violations;
      if (audit.done) break;
    }

    await t.run(async (ctx) => {
      const legacyCalendar = await ctx.db.get(legacyCalendarId);
      const detachedConnections = (
        await ctx.db
          .query("calendarConnections")
          .withIndex("by_user_and_provider", (query) =>
            query.eq("userId", USER).eq("provider", "google"),
          )
          .collect()
      ).filter((row) => row.legacyMigrationState === "detached");
      expect(detachedConnections).toHaveLength(1);
      expect(detachedConnections[0]).toMatchObject({
        status: "paused",
        lastError: "legacy_identity_required",
      });
      expect(detachedConnections[0]?._id).not.toBe(accountConnectionId);
      expect(legacyCalendar).toMatchObject({
        connectionId: detachedConnections[0]?._id,
        providerCalendarId: "late-legacy-calendar",
      });
    });
    expect(cursor).toBeUndefined();
    expect(auditCursor).toBeUndefined();
    expect(violations).toBe(0);
  });

  test("scoped migration repairs bound operation snapshots from the single-account format", async () => {
    const t = convexTest(schema, modules);
    const operationId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
        status: "active",
        legacyMigrationState: "complete",
        createdAt: 1,
        updatedAt: 1,
      });
      const legacySnapshot = {
        localEventId: "legacy_local_bound_001",
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        remoteEventId: "remote-bound-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed" as const,
      };
      return ctx.db.insert("calendarOperations", {
        connectionId,
        userId: USER,
        operationId: "operation_bound_update_001",
        idempotencyKey: "idempotency-bound-update",
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        providerCalendarId: "primary",
        localEventId: "legacy_local_bound_001",
        remoteEventId: "remote-bound-1",
        providerEventId: "remote-bound-1",
        kind: "update",
        payload: { event: legacySnapshot },
        baseRemoteSnapshot: legacySnapshot,
        uploadBaseRemoteSnapshot: legacySnapshot,
        state: "pending",
        status: "pending",
        leaseReady: true,
        attemptCount: 0,
        createdAt: 2,
        updatedAt: 3,
      });
    });
    const broker = t.withIdentity(brokerIdentity());
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        {
          accountId: ACCOUNT_A,
          providerAccountId: "sub-a",
          cursor,
        },
      );
      cursor = result.cursor;
      if (result.done) break;
    }

    await t.run(async (ctx) => {
      const operation = await ctx.db.get(operationId);
      expect(operation?.payload).toMatchObject({
        event: {
          accountId: ACCOUNT_A,
          calendarId: CALENDAR_A,
          providerCalendarId: "primary",
        },
      });
      expect(operation?.baseRemoteSnapshot).toMatchObject({
        calendarId: CALENDAR_A,
        providerCalendarId: "primary",
      });
      expect(operation?.uploadBaseRemoteSnapshot).toMatchObject({
        calendarId: CALENDAR_A,
        providerCalendarId: "primary",
      });
    });
  });

  test("scoped migration recovers a hashed event calendar from its bound membership", async () => {
    const t = convexTest(schema, modules);
    const { eventId, offlineEventId, seriesId } = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
        status: "active",
        legacyMigrationState: "complete",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        connectionId,
        accountId: ACCOUNT_A,
        calendarKey: CALENDAR_A,
        googleCalendarId: CALENDAR_A,
        providerCalendarId: "primary",
        selected: true,
      });
      const eventId = await ctx.db.insert("events", {
        userId: USER,
        connectionId,
        localEventId: "legacy_local_bound_event_001",
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        googleEventId: "remote-bound-event-1",
        providerEventId: "remote-bound-event-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1,
        remoteSnapshot: {
          localEventId: "legacy_local_bound_event_001",
          accountId: ACCOUNT_A,
          calendarId: CALENDAR_A,
          remoteEventId: "remote-bound-event-1",
          startMs: 1_000,
          endMs: 2_000,
          allDay: false,
          status: "confirmed",
        },
        syncState: "synced",
      });
      const offlineEventId = await ctx.db.insert("events", {
        userId: USER,
        localEventId: "legacy_local_pending_event_001",
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        googleEventId: "local-pending-event-1",
        providerEventId: "deterministic-provider-event-1",
        startMs: 3_000,
        endMs: 4_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 2,
        providerUpdatedMs: 0,
        syncState: "pending",
      });
      const seriesId = await ctx.db.insert("recurringSeries", {
        userId: USER,
        connectionId,
        calendarId: CALENDAR_A,
        googleEventId: "series-bound-1",
        recurrence: ["RRULE:FREQ=WEEKLY"],
        sourceUpdatedMs: 1,
      });
      return { eventId, offlineEventId, seriesId };
    });
    const broker = t.withIdentity(brokerIdentity());
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        {
          accountId: ACCOUNT_A,
          providerAccountId: "sub-a",
          cursor,
        },
      );
      cursor = result.cursor;
      if (result.done) break;
    }

    await t.run(async (ctx) => {
      expect(await ctx.db.get(eventId)).toMatchObject({
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        remoteSnapshot: {
          accountId: ACCOUNT_A,
          calendarId: CALENDAR_A,
          providerCalendarId: "primary",
        },
      });
      expect(await ctx.db.get(seriesId)).toMatchObject({
        calendarId: CALENDAR_A,
        providerCalendarId: "primary",
        providerEventId: "series-bound-1",
      });
      expect(await ctx.db.get(offlineEventId)).toMatchObject({
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        providerEventId: "deterministic-provider-event-1",
        providerUpdatedMs: 0,
        syncState: "pending",
      });
    });

    let auditCursor: string | undefined;
    let violations = 0;
    for (let page = 0; page < 10; page += 1) {
      const audit = await broker.query(
        desktopQuery("auditGoogleAccountMigration"),
        { accountId: ACCOUNT_A, cursor: auditCursor },
      );
      auditCursor = audit.cursor;
      violations += audit.violations;
      if (audit.done) break;
    }
    expect(violations).toBe(0);
  });

  test("scoped migration resolves bound move calendar keys through account memberships", async () => {
    const t = convexTest(schema, modules);
    const operationId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        accountId: ACCOUNT_A,
        providerAccountId: "sub-a",
        status: "active",
        legacyMigrationState: "complete",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        connectionId,
        accountId: ACCOUNT_A,
        calendarKey: CALENDAR_A,
        googleCalendarId: CALENDAR_A,
        providerCalendarId: "primary",
        selected: true,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        connectionId,
        accountId: ACCOUNT_A,
        calendarKey: OTHER_A,
        googleCalendarId: OTHER_A,
        providerCalendarId: "other",
        selected: true,
      });
      return ctx.db.insert("calendarOperations", {
        connectionId,
        userId: USER,
        operationId: "operation_bound_move_001",
        idempotencyKey: "idempotency-bound-move",
        accountId: ACCOUNT_A,
        calendarId: CALENDAR_A,
        localEventId: "legacy_local_bound_move_001",
        remoteEventId: "remote-bound-move-1",
        providerEventId: "remote-bound-move-1",
        kind: "move",
        payload: { destinationCalendarId: OTHER_A },
        state: "pending",
        status: "pending",
        leaseReady: true,
        attemptCount: 0,
        createdAt: 2,
        updatedAt: 3,
      });
    });
    const broker = t.withIdentity(brokerIdentity());
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        {
          accountId: ACCOUNT_A,
          providerAccountId: "sub-a",
          cursor,
        },
      );
      cursor = result.cursor;
      if (result.done) break;
    }

    await t.run(async (ctx) => {
      expect(await ctx.db.get(operationId)).toMatchObject({
        providerCalendarId: "primary",
        payload: {
          destinationCalendarId: OTHER_A,
          destinationProviderCalendarId: "other",
        },
      });
    });
  });

  test("unknown legacy identity is paused and attached without guessing an account", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: "primary",
        providerCalendarId: "primary",
        selected: true,
      });
      return id;
    });
    const broker = t.withIdentity(brokerIdentity());
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        { cursor },
      );
      cursor = result.cursor;
      if (result.done) break;
    }
    await t.run(async (ctx) => {
      expect(await ctx.db.get(connectionId)).toMatchObject({
        status: "paused",
        lastError: "legacy_identity_required",
        legacyMigrationState: "detached",
      });
      expect(await ctx.db.query("calendars").unique()).toMatchObject({
        googleCalendarId: "primary",
        providerCalendarId: "primary",
        connectionId,
      });
    });
  });

  test("detaching legacy data does not absorb an unrelated stable account row", async () => {
    const t = convexTest(schema, modules);
    const { legacyConnectionId, stableCalendarId } = await t.run(
      async (ctx) => {
        const legacyConnectionId = await ctx.db.insert("calendarConnections", {
          userId: USER,
          provider: "google",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("calendars", {
          userId: USER,
          googleCalendarId: "primary",
          providerCalendarId: "primary",
          selected: true,
        });
        const stableCalendarId = await ctx.db.insert("calendars", {
          userId: USER,
          accountId: ACCOUNT_B,
          googleCalendarId: CALENDAR_B,
          calendarKey: CALENDAR_B,
          providerCalendarId: "primary",
          selected: true,
        });
        return { legacyConnectionId, stableCalendarId };
      },
    );
    const broker = t.withIdentity(brokerIdentity());
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await broker.mutation(
        desktopMutation("migrateLegacyGoogleData"),
        { cursor },
      );
      cursor = result.cursor;
      if (result.done) break;
    }

    await t.run(async (ctx) => {
      const stableCalendar = await ctx.db.get(stableCalendarId);
      expect(stableCalendar).toMatchObject({ accountId: ACCOUNT_B });
      expect(stableCalendar?.connectionId).toBeUndefined();
      expect(await ctx.db.get(legacyConnectionId)).toMatchObject({
        legacyMigrationState: "detached",
      });
    });
  });
});
