/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import {
  googleConferenceRequestIdForOperation,
  googleEventIdForOperation,
  localEventIdForOperation,
} from "../../lib/assistantLogic";
import { LOCAL_AUTH_ISSUERS, LOCAL_AUTH_SUBJECT } from "../desktop/identity";

const modules = import.meta.glob("../../**/*.ts");
const USER = LOCAL_AUTH_SUBJECT;
const ACCOUNT = "account_001";
const CALENDAR = "primary@example.com";

function rendererIdentity() {
  return {
    issuer: LOCAL_AUTH_ISSUERS.test,
    subject: USER,
    tokenIdentifier: `${LOCAL_AUTH_ISSUERS.test}|${USER}`,
    email: "local@qali.app",
    name: "Qali User",
    role: "renderer" as const,
  };
}

async function seedCalendar(
  t: ReturnType<typeof convexTest>,
  accessRole: "owner" | "reader" = "owner",
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId: USER,
      provider: "google",
      providerAccountId: ACCOUNT,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const calendarId = await ctx.db.insert("calendars", {
      userId: USER,
      googleCalendarId: CALENDAR,
      providerCalendarId: CALENDAR,
      accountId: ACCOUNT,
      connectionId,
      accessRole,
      primary: true,
      selected: true,
    });
    return { calendarId, connectionId };
  });
}

describe("calendar writes commit to the local ledger", () => {
  test("a local write never replaces a raw provider calendar id with its local key", async () => {
    const t = convexTest(schema, modules);
    const localCalendarId =
      "gcal__5F2wr5WnjKzUjzhqPIPAJlZJdhJAjQnNye2bgDS0yY";
    await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        accountId:
          "gacc_AXOeTQcAOOzuZDa1gSo7yzrwYsizbVepkObxz3dP8d4",
        providerAccountId: "sub-a",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: localCalendarId,
        calendarKey: localCalendarId,
        providerCalendarId: "primary",
        accountId:
          "gacc_AXOeTQcAOOzuZDa1gSo7yzrwYsizbVepkObxz3dP8d4",
        connectionId,
        accessRole: "owner",
        primary: true,
        selected: true,
      });
    });

    await t.withIdentity(rendererIdentity()).action(api.calendar.createEvent, {
      operationId: "operation_provider_calendar_001",
      calendarId: localCalendarId,
      summary: "Identity boundary",
      startMs: 1_000,
      endMs: 2_000,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("calendars").unique()).toMatchObject({
        googleCalendarId: localCalendarId,
        providerCalendarId: "primary",
      });
      expect(await ctx.db.query("calendarOperations").unique()).toMatchObject({
        calendarId: localCalendarId,
        providerCalendarId: "primary",
      });
    });
  });

  test("an offline create is projected once with deterministic sync identities", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const renderer = t.withIdentity(rendererIdentity());
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Google is unreachable"));
    const operationId = "operation_offline_create_001";

    const first = await renderer.action(api.calendar.createEvent, {
      operationId,
      calendarId: CALENDAR,
      summary: "Offline planning",
      startMs: 1_000,
      endMs: 2_000,
      addConference: true,
      recurrence: ["RRULE:FREQ=WEEKLY"],
      timeZone: "Europe/Paris",
    });
    const second = await renderer.action(api.calendar.createEvent, {
      operationId,
      calendarId: CALENDAR,
      summary: "Offline planning",
      startMs: 1_000,
      endMs: 2_000,
      addConference: true,
      recurrence: ["RRULE:FREQ=WEEKLY"],
      timeZone: "Europe/Paris",
    });

    expect(first).toMatchObject({
      operationId,
      localEventId: localEventIdForOperation(operationId),
      providerEventId: googleEventIdForOperation(operationId),
      syncState: "pending",
    });
    expect(second).toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    await t.run(async (ctx) => {
      const operations = await ctx.db.query("calendarOperations").collect();
      const events = await ctx.db.query("events").collect();
      expect(operations).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        operationId,
        kind: "create",
        state: "pending",
        payload: {
          event: {
            localEventId: localEventIdForOperation(operationId),
            recurrenceScope: "allEvents",
            conference: {
              requestId: googleConferenceRequestIdForOperation(operationId),
            },
          },
        },
      });
      expect(events[0]).toMatchObject({
        providerEventId: googleEventIdForOperation(operationId),
        syncState: "pending",
      });
    });
    fetchSpy.mockRestore();
  });

  test("the first provider snapshot reconciles into its local create projection", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const operationId = "operation_provider_reconcile_001";
    const providerEventId = googleEventIdForOperation(operationId);
    const localEventId = localEventIdForOperation(operationId);

    await t.withIdentity(rendererIdentity()).action(api.calendar.createEvent, {
      operationId,
      calendarId: CALENDAR,
      summary: "One logical event",
      startMs: 10_000,
      endMs: 20_000,
    });
    await t.mutation(internal.calendar.upsertEvent, {
      userId: USER,
      event: {
        googleEventId: providerEventId,
        calendarId: CALENDAR,
        summary: "One logical event",
        startMs: 10_000,
        endMs: 20_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 30_000,
      },
    });

    await t.run(async (ctx) => {
      const events = await ctx.db.query("events").collect();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        localEventId,
        googleEventId: providerEventId,
        providerEventId,
        summary: "One logical event",
      });
    });
  });

  test("a provider refresh repairs duplicate rows created by the legacy identity lookup", async () => {
    const t = convexTest(schema, modules);
    const { connectionId } = await seedCalendar(t);
    const operationId = "operation_provider_repair_001";
    const providerEventId = googleEventIdForOperation(operationId);
    const localEventId = localEventIdForOperation(operationId);

    await t.withIdentity(rendererIdentity()).action(api.calendar.createEvent, {
      operationId,
      calendarId: CALENDAR,
      summary: "Repair me",
      startMs: 10_000,
      endMs: 20_000,
    });
    // This is the exact shape left by the previous importer: a canonical
    // Google row was inserted beside the optimistic local projection.
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        userId: USER,
        accountId: ACCOUNT,
        connectionId,
        localEventId: `remote:${providerEventId}`,
        providerEventId,
        providerUpdatedMs: 25_000,
        googleEventId: providerEventId,
        calendarId: CALENDAR,
        summary: "Repair me",
        startMs: 10_000,
        endMs: 20_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 25_000,
      });
      expect(await ctx.db.query("events").collect()).toHaveLength(2);
    });

    await t.mutation(internal.calendar.upsertEvent, {
      userId: USER,
      event: {
        googleEventId: providerEventId,
        calendarId: CALENDAR,
        summary: "Repair me",
        startMs: 10_000,
        endMs: 20_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 30_000,
      },
    });

    await t.run(async (ctx) => {
      const events = await ctx.db.query("events").collect();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        localEventId,
        googleEventId: providerEventId,
        providerEventId,
        googleUpdatedMs: 30_000,
      });
    });
  });

  test("a read-only calendar rejects before projection or queue insertion", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t, "reader");
    const renderer = t.withIdentity(rendererIdentity());

    await expect(
      renderer.action(api.calendar.createEvent, {
        operationId: "operation_read_only_001",
        calendarId: CALENDAR,
        summary: "Must not appear",
        startMs: 1_000,
        endMs: 2_000,
      }),
    ).rejects.toThrow("CALENDAR_READ_ONLY");

    await t.run(async (ctx) => {
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(
        0,
      );
      expect(await ctx.db.query("events").collect()).toHaveLength(0);
    });
  });

  test("update, drag, RSVP and scoped delete each append local intent", async () => {
    const t = convexTest(schema, modules);
    const { connectionId } = await seedCalendar(t);
    const localEventId = "local_remote_event_001";
    const remoteSnapshot = {
      localEventId,
      accountId: ACCOUNT,
      calendarId: CALENDAR,
      remoteEventId: "remote-event-1",
      summary: "Remote title",
      startMs: 1_000,
      endMs: 2_000,
      allDay: false,
      status: "confirmed",
      attendees: [
        { email: "local@qali.app", self: true, responseStatus: "needsAction" },
      ],
    };
    const eventId = await t.run((ctx) =>
      ctx.db.insert("events", {
        userId: USER,
        localEventId,
        accountId: ACCOUNT,
        connectionId,
        calendarId: CALENDAR,
        googleEventId: "remote-event-1",
        providerEventId: "remote-event-1",
        summary: "Remote title",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 500,
        organizer: { self: true },
        recurringEventId: "series-master-1",
        attendees: [
          {
            email: "local@qali.app",
            self: true,
            responseStatus: "needsAction",
          },
        ],
        remoteSnapshot,
        remoteEtag: "etag-1",
        syncState: "synced",
      }),
    );
    const renderer = t.withIdentity(rendererIdentity());

    await renderer.action(api.calendar.updateEvent, {
      eventId,
      summary: "Local title",
      scope: "thisAndFollowing",
      operationId: "operation_update_scope_001",
    });
    await renderer.action(api.calendar.updateEventTime, {
      eventId,
      startMs: 3_000,
      endMs: 4_000,
      timeZone: "Europe/Paris",
    });
    await renderer.action(api.calendar.respondToEvent, {
      eventId,
      responseStatus: "accepted",
    });
    const deleted = await renderer.action(api.calendar.deleteEvent, {
      eventId,
      scope: "allEvents",
      operationId: "operation_delete_scope_001",
    });

    expect(deleted).toMatchObject({ syncState: "pending", deleted: true });
    await t.run(async (ctx) => {
      const operations = await ctx.db.query("calendarOperations").collect();
      expect(operations.map((operation) => operation.kind)).toEqual([
        "update",
        "update",
        "respond",
        "delete",
      ]);
      expect(operations[0]?.payload).toMatchObject({
        patch: { summary: "Local title", recurrenceScope: "thisAndFollowing" },
      });
      expect(operations[3]?.payload).toEqual({ recurrenceScope: "allEvents" });
      expect(await ctx.db.get(eventId as Id<"events">)).toBeNull();
    });
  });

  test("a real synced baseline preserves RSVP authority through attendee replacement", async () => {
    const t = convexTest(schema, modules);
    const { calendarId, connectionId } = await seedCalendar(t);
    const accountId = String(connectionId);
    await t.run((ctx) => ctx.db.patch(calendarId, { accountId }));
    await t.mutation(internal.calendar.upsertEvent, {
      userId: USER,
      event: {
        googleEventId: "remote-rsvp-1",
        calendarId: CALENDAR,
        summary: "Invitation",
        startMs: 10_000,
        endMs: 20_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 700,
        organizer: { self: true },
        attendees: [
          {
            email: "local@qali.app",
            self: true,
            organizer: true,
            responseStatus: "needsAction",
          },
        ],
      },
    });
    const eventId = await t.run(async (ctx) => {
      const row = await ctx.db.query("events").unique();
      if (!row) throw new Error("missing event");
      await ctx.db.patch(row._id, { remoteEtag: "etag-rsvp", syncState: "synced" });
      return row._id;
    });
    const renderer = t.withIdentity(rendererIdentity());

    await renderer.action(api.calendar.updateEvent, {
      eventId,
      attendees: [{ email: "guest@example.com", displayName: "Guest" }],
      operationId: "operation_attendees_001",
    });
    await renderer.action(api.calendar.respondToEvent, {
      eventId,
      responseStatus: "accepted",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(eventId);
      const self = row?.attendees?.find((attendee) => attendee.self === true);
      expect(self).toMatchObject({
        email: "local@qali.app",
        organizer: true,
        self: true,
        responseStatus: "accepted",
      });
      expect(row?.attendees).toContainEqual(
        expect.objectContaining({ email: "guest@example.com" }),
      );
      const operations = await ctx.db.query("calendarOperations").collect();
      expect(operations).toHaveLength(2);
      expect(operations[0]?.baseRemoteSnapshot?.attendees).toContainEqual(
        expect.objectContaining({
          email: "local@qali.app",
          organizer: true,
          self: true,
        }),
      );
    });
  });

  test("stale this-and-following delete rejects without changing projection", async () => {
    const t = convexTest(schema, modules);
    const { connectionId } = await seedCalendar(t);
    const localEventId = "local_stale_series_001";
    const remoteSnapshot = {
      localEventId,
      accountId: ACCOUNT,
      calendarId: CALENDAR,
      remoteEventId: "remote-series-instance-1",
      summary: "Series",
      startMs: 30_000,
      endMs: 40_000,
      allDay: false,
      status: "confirmed",
    };
    const eventId = await t.run(async (ctx) => {
      await ctx.db.insert("recurringSeries", {
        userId: USER,
        calendarId: CALENDAR,
        googleEventId: "series-master-stale",
        recurrence: ["RRULE:FREQ=WEEKLY"],
        sourceUpdatedMs: 900,
      });
      return ctx.db.insert("events", {
        userId: USER,
        localEventId,
        accountId: ACCOUNT,
        connectionId,
        calendarId: CALENDAR,
        googleEventId: "remote-series-instance-1",
        summary: "Series",
        startMs: 30_000,
        endMs: 40_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 900,
        organizer: { self: true },
        recurringEventId: "series-master-stale",
        remoteSnapshot,
        remoteEtag: "etag-series",
        syncState: "synced",
      });
    });
    const renderer = t.withIdentity(rendererIdentity());

    await expect(
      renderer.action(api.calendar.deleteEvent, {
        eventId,
        scope: "thisAndFollowing",
        operationId: "operation_stale_delete_001",
        expectedSeriesUpdatedMs: 800,
      }),
    ).rejects.toThrow("recurring series changed");

    await t.run(async (ctx) => {
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(0);
      expect(await ctx.db.get(eventId)).toMatchObject({
        summary: "Series",
        syncState: "synced",
      });
    });
  });

  test("drag and RSVP exact retries reuse one deterministic operation", async () => {
    const t = convexTest(schema, modules);
    const { connectionId } = await seedCalendar(t);
    const localEventId = "local_retry_event_001";
    const remoteSnapshot = {
      localEventId,
      accountId: ACCOUNT,
      calendarId: CALENDAR,
      remoteEventId: "remote-retry-event-1",
      startMs: 50_000,
      endMs: 60_000,
      allDay: false,
      status: "confirmed",
      attendees: [
        { email: "local@qali.app", self: true, responseStatus: "needsAction" },
      ],
    };
    const eventId = await t.run((ctx) =>
      ctx.db.insert("events", {
        userId: USER,
        localEventId,
        accountId: ACCOUNT,
        connectionId,
        calendarId: CALENDAR,
        googleEventId: "remote-retry-event-1",
        startMs: 50_000,
        endMs: 60_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1_000,
        organizer: { self: true },
        attendees: [
          {
            email: "local@qali.app",
            self: true,
            responseStatus: "needsAction",
          },
        ],
        remoteSnapshot,
        remoteEtag: "etag-retry",
        syncState: "synced",
      }),
    );
    const renderer = t.withIdentity(rendererIdentity());

    const drag = { eventId, startMs: 70_000, endMs: 80_000 };
    const firstDrag = await renderer.action(api.calendar.updateEventTime, drag);
    const retryDrag = await renderer.action(api.calendar.updateEventTime, drag);
    const distinctDrag = await renderer.action(api.calendar.updateEventTime, {
      eventId,
      startMs: 90_000,
      endMs: 100_000,
    });
    const firstRsvp = await renderer.action(api.calendar.respondToEvent, {
      eventId,
      responseStatus: "accepted",
    });
    const retryRsvp = await renderer.action(api.calendar.respondToEvent, {
      eventId,
      responseStatus: "accepted",
    });
    const distinctRsvp = await renderer.action(api.calendar.respondToEvent, {
      eventId,
      responseStatus: "declined",
    });

    expect(retryDrag.operationId).toBe(firstDrag.operationId);
    expect(distinctDrag.operationId).not.toBe(firstDrag.operationId);
    expect(retryRsvp.operationId).toBe(firstRsvp.operationId);
    expect(distinctRsvp.operationId).not.toBe(firstRsvp.operationId);
    await t.run(async (ctx) => {
      const operations = await ctx.db.query("calendarOperations").collect();
      expect(operations.filter((operation) => operation.kind === "update")).toHaveLength(2);
      expect(operations.filter((operation) => operation.kind === "respond")).toHaveLength(2);
    });
  });
});
