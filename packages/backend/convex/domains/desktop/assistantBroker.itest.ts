/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, test, vi } from "vitest";

import { api } from "../../_generated/api";
import schema from "../../schema";
import { LOCAL_AUTH_ISSUERS, LOCAL_AUTH_SUBJECT } from "./identity";

const modules = import.meta.glob("../../**/*.ts");
const USER = LOCAL_AUTH_SUBJECT;
const CALENDAR = "primary@example.test";
const OTHER_CALENDAR = "other@example.test";
const ACCOUNT = "google-local-account";

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
  ).desktopAssistant![name]!;
}

function desktopQuery(name: string): FunctionReference<"query"> {
  return (
    api as unknown as Record<string, Record<string, FunctionReference<"query">>>
  ).desktopAssistant![name]!;
}

async function seedCalendar(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId: USER,
      provider: "google",
      providerAccountId: ACCOUNT,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("calendars", {
      userId: USER,
      googleCalendarId: CALENDAR,
      providerCalendarId: CALENDAR,
      accountId: ACCOUNT,
      connectionId,
      accessRole: "owner",
      primary: true,
      selected: true,
    });
    await ctx.db.insert("calendars", {
      userId: USER,
      googleCalendarId: OTHER_CALENDAR,
      providerCalendarId: OTHER_CALENDAR,
      accountId: ACCOUNT,
      connectionId,
      accessRole: "reader",
      selected: false,
    });
    const eventId = await ctx.db.insert("events", {
      userId: USER,
      localEventId: "local-event-1",
      accountId: ACCOUNT,
      connectionId,
      calendarId: CALENDAR,
      googleEventId: "remote-event-1",
      remoteEtag: "etag-1",
      summary: "Lunch",
      description: "Private notes",
      location: "https://meet.example.test/room",
      startMs: 100,
      endMs: 200,
      allDay: false,
      status: "confirmed",
      googleUpdatedMs: 7,
      organizer: { self: true },
      attendees: [{ email: "guest@example.test", responseStatus: "accepted" }],
      syncState: "synced",
    });
    await ctx.db.insert("events", {
      userId: "different-user",
      localEventId: "other-user-event",
      accountId: ACCOUNT,
      calendarId: CALENDAR,
      googleEventId: "other-user-remote-event",
      summary: "Must not leak",
      startMs: 100,
      endMs: 200,
      allDay: false,
      status: "confirmed",
      googleUpdatedMs: 8,
      syncState: "synced",
    });
    return { eventId };
  });
}

async function beginAttempt(
  broker: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  attemptId = "attempt-1",
) {
  return broker.mutation(desktopMutation("beginAttempt"), {
    attemptId,
    text: "What is next?",
    timeZone: "Europe/Paris",
    nowMs: 500,
  });
}

describe("desktop assistant broker", () => {
  test("broker persists user, assistant placeholder, and attempt atomically before launch", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));

    const started = await beginAttempt(broker);
    expect(started).toMatchObject({
      selectedCalendarIds: [CALENDAR],
      summary: [],
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("assistantMessages").collect()).toHaveLength(2);
      expect(await ctx.db.query("assistantAttempts").collect()).toMatchObject([
        {
          attemptId: "attempt-1",
          state: "persisted",
          terminal: false,
          nextEventSequence: 2,
        },
      ]);
      expect(await ctx.db.query("assistantAttemptEvents").collect()).toMatchObject([
        {
          attemptId: "attempt-1",
          sequence: 1,
          event: { kind: "attempt_started" },
        },
      ]);
    });
  });

  test("broker appends closed normalized events monotonically and reconnects from a cursor", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);

    const first = await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:phase-planning",
      event: {
        kind: "phase",
        phase: "planning",
        evidenceDigest: "sha256:planning",
      },
    });
    const duplicate = await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:phase-planning",
      event: {
        kind: "phase",
        phase: "planning",
        evidenceDigest: "sha256:planning",
      },
    });
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:phase-reading",
      event: { kind: "phase", phase: "reading" },
    });
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({ sequence: 2 });

    const replay = await broker.query(desktopQuery("listAttemptEvents"), {
      attemptId: "attempt-1",
      afterSequence: 1,
      limit: 10,
    });
    expect(replay).toMatchObject({
      gap: null,
      nextAfterSequence: 3,
      events: [
        { sequence: 2, event: { kind: "phase", phase: "planning" } },
        { sequence: 3, event: { kind: "phase", phase: "reading" } },
      ],
    });
  });

  test("replay reports an explicit recovery gap when retained history starts after the cursor", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:phase-planning",
      event: { kind: "phase", phase: "planning" },
    });
    await t.run(async (ctx) => {
      const first = await ctx.db
        .query("assistantAttemptEvents")
        .withIndex("by_attemptId_and_sequence", (query) =>
          query.eq("attemptId", "attempt-1"),
        )
        .first();
      await ctx.db.delete(first!._id);
    });

    await expect(
      broker.query(desktopQuery("listAttemptEvents"), {
        attemptId: "attempt-1",
        afterSequence: 0,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      gap: {
        requestedAfterSequence: 0,
        earliestAvailableSequence: 2,
        recovery: "reload_attempt",
      },
    });
  });

  test("broker rejects invalid event order and raw native payloads", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);

    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-1",
        eventId: "event:read-too-soon",
        event: { kind: "phase", phase: "reading" },
      }),
    ).rejects.toThrow("ASSISTANT_EVENT_ORDER_INVALID");
    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-1",
        eventId: "event:cancel-ack-too-soon",
        event: { kind: "cancel", milestone: "native_acknowledged" },
      }),
    ).rejects.toThrow("ASSISTANT_EVENT_ORDER_INVALID");
    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-1",
        eventId: "event:evidence-too-large",
        event: {
          kind: "phase",
          phase: "planning",
          evidenceDigest: "x".repeat(257),
        },
      }),
    ).rejects.toThrow("ASSISTANT_EVENT_INVALID");
    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-1",
        eventId: "event:unsafe",
        event: {
          kind: "phase",
          phase: "planning",
          rawFrame: '{"native":"frame"}',
          stderr: "secret",
          nativeTurnId: "turn-42",
        },
      }),
    ).rejects.toThrow();
  });

  test("cancellation milestones and outcome-unknown settlement append once", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);

    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:phase-planning",
      event: { kind: "phase", phase: "planning" },
    });
    await broker.mutation(desktopMutation("requestCancellation"), {
      attemptId: "attempt-1",
    });
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:cancel-sent",
      event: { kind: "cancel", milestone: "interrupt_sent" },
    });
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:cancel-ack",
      event: { kind: "cancel", milestone: "interrupt_acknowledged" },
    });
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:cancel-owned-process-terminated",
      event: { kind: "cancel", milestone: "owned_process_terminated" },
    });
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-1",
      eventId: "event:cancel-outcome-unknown",
      event: { kind: "cancel", milestone: "outcome_unknown" },
    });
    const first = await broker.mutation(desktopMutation("settleFailure"), {
      attemptId: "attempt-1",
      code: "outcome-unknown",
    });
    const second = await broker.mutation(desktopMutation("settleFailure"), {
      attemptId: "attempt-1",
      code: "outcome-unknown",
    });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "outcome-unknown" });

    const replay = await broker.query(desktopQuery("listAttemptEvents"), {
      attemptId: "attempt-1",
      afterSequence: 0,
      limit: 20,
    });
    expect(replay.events.map((row: { event: { kind: string } }) => row.event.kind)).toEqual([
      "attempt_started",
      "phase",
      "cancel",
      "cancel",
      "cancel",
      "cancel",
      "cancel",
      "terminal",
    ]);
    expect(replay.events.at(-1)).toMatchObject({
      event: { kind: "terminal", outcome: "outcome_unknown" },
    });
  });

  test("records truthful cancellation branches and only lets a completed finalizer settle", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));

    await beginAttempt(broker, "attempt-semantic");
    await broker.mutation(desktopMutation("requestCancellation"), {
      attemptId: "attempt-semantic",
    });
    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-semantic",
        eventId: "event:semantic-without-native-ids",
        event: { kind: "cancel", milestone: "semantically_interrupted" },
      }),
    ).resolves.toMatchObject({ sequence: 3 });
    await broker.mutation(desktopMutation("settleFailure"), {
      attemptId: "attempt-semantic",
      code: "cancelled",
    });

    await beginAttempt(broker, "attempt-termination");
    await broker.mutation(desktopMutation("requestCancellation"), {
      attemptId: "attempt-termination",
    });
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-termination",
      eventId: "event:interrupt-sent",
      event: { kind: "cancel", milestone: "interrupt_sent" },
    });
    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-termination",
        eventId: "event:terminated-without-ack",
        event: { kind: "cancel", milestone: "owned_process_terminated" },
      }),
    ).resolves.toMatchObject({ sequence: 4 });
    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-termination",
        eventId: "event:unknown-after-termination",
        event: { kind: "cancel", milestone: "outcome_unknown" },
      }),
    ).resolves.toMatchObject({ sequence: 5 });
    await broker.mutation(desktopMutation("settleFailure"), {
      attemptId: "attempt-termination",
      code: "outcome-unknown",
    });

    await beginAttempt(broker, "attempt-finalizer");
    await broker.mutation(desktopMutation("recordProgress"), {
      attemptId: "attempt-finalizer",
      state: "planning",
    });
    await broker.mutation(desktopMutation("recordProgress"), {
      attemptId: "attempt-finalizer",
      state: "reading",
    });
    await broker.mutation(desktopMutation("recordProgress"), {
      attemptId: "attempt-finalizer",
      state: "finalizing",
    });
    await broker.mutation(desktopMutation("requestCancellation"), {
      attemptId: "attempt-finalizer",
    });
    await broker.mutation(desktopMutation("recordEvent"), {
      attemptId: "attempt-finalizer",
      eventId: "event:finalizer-completed-before-interrupt",
      event: { kind: "cancel", milestone: "completed_before_interrupt" },
    });
    await expect(
      broker.mutation(desktopMutation("settleSuccess"), {
        attemptId: "attempt-finalizer",
        markdown: "Finalizer had already completed.",
        proposals: [],
      }),
    ).resolves.toMatchObject({ state: "completed" });
  });

  test("legacy active attempts initialize their missing sequence from durable events", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    await t.run(async (ctx) => {
      const attempt = (await ctx.db.query("assistantAttempts").collect())[0]!;
      await ctx.db.patch(attempt._id, { nextEventSequence: undefined });
    });

    await expect(
      broker.mutation(desktopMutation("recordProgress"), {
        attemptId: "attempt-1",
        state: "planning",
      }),
    ).resolves.toEqual({ state: "planning" });
    await t.run(async (ctx) => {
      const attempt = (await ctx.db.query("assistantAttempts").collect())[0]!;
      expect(attempt.nextEventSequence).toBe(3);
      expect(
        (await ctx.db.query("assistantAttemptEvents").collect()).map(
          (event) => event.sequence,
        ),
      ).toEqual([1, 2]);
    });
  });

  test("external event retries remain idempotent after terminal settlement", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    const event = {
      attemptId: "attempt-1",
      eventId: "event:phase-planning",
      event: { kind: "phase" as const, phase: "planning" as const },
    };
    const first = await broker.mutation(desktopMutation("recordEvent"), event);
    await broker.mutation(desktopMutation("settleSuccess"), {
      attemptId: "attempt-1",
      markdown: "Completed.",
      proposals: [],
    });

    await expect(
      broker.mutation(desktopMutation("recordEvent"), event),
    ).resolves.toEqual(first);
  });

  test("external event IDs cannot reserve broker lifecycle event IDs", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);

    await expect(
      broker.mutation(desktopMutation("recordEvent"), {
        attemptId: "attempt-1",
        eventId: "internal:phase-planning",
        event: { kind: "phase", phase: "planning" },
      }),
    ).rejects.toThrow("ASSISTANT_EVENT_ID_RESERVED");
    await expect(
      broker.mutation(desktopMutation("recordProgress"), {
        attemptId: "attempt-1",
        state: "planning",
      }),
    ).resolves.toEqual({ state: "planning" });
  });

  test("renderer cannot persist, read, progress, cancel, or settle privileged attempts", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const renderer = t.withIdentity(identity("renderer"));
    await expect(beginAttempt(renderer)).rejects.toThrow(
      "DESKTOP_BROKER_REQUIRED",
    );
    await expect(
      renderer.query(desktopQuery("readCalendar"), {
        attemptId: "attempt-1",
        selectedCalendarIds: [CALENDAR],
        reads: [{ kind: "listCalendars", limit: 10 }],
      }),
    ).rejects.toThrow("DESKTOP_BROKER_REQUIRED");
    await expect(
      renderer.mutation(desktopMutation("recordProgress"), {
        attemptId: "attempt-1",
        state: "planning",
      }),
    ).rejects.toThrow("DESKTOP_BROKER_REQUIRED");
    await expect(
      renderer.mutation(desktopMutation("requestCancellation"), {
        attemptId: "attempt-1",
      }),
    ).rejects.toThrow("DESKTOP_BROKER_REQUIRED");
    await expect(
      renderer.mutation(desktopMutation("settleFailure"), {
        attemptId: "attempt-1",
        code: "process-failure",
      }),
    ).rejects.toThrow("DESKTOP_BROKER_REQUIRED");
  });

  test("local reads expose only selected scoped minimal rows", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);

    const result = await broker.query(desktopQuery("readCalendar"), {
      attemptId: "attempt-1",
      selectedCalendarIds: [CALENDAR],
      reads: [
        { kind: "listCalendars", limit: 10 },
        {
          kind: "searchEvents",
          calendarIds: [CALENDAR],
          startMs: 0,
          endMs: 1_000,
          limit: 10,
        },
        { kind: "getEvent", calendarId: CALENDAR, eventId: "local-event-1" },
      ],
    });
    expect(result.rows[0].items).toEqual([
      expect.objectContaining({
        calendarId: CALENDAR,
        selected: true,
        writable: true,
      }),
    ]);
    expect(result.rows[1].items).toEqual([
      expect.objectContaining({
        eventId: "local-event-1",
        calendarId: CALENDAR,
        summary: "Lunch",
      }),
    ]);
    expect(result.rows[1].items[0]).not.toHaveProperty("userId");
    expect(result.rows[1].items[0]).not.toHaveProperty("accountId");
    expect(result.rows[1].items[0]).not.toHaveProperty("description");
    expect(result.rows[1].items[0]).not.toHaveProperty("location");
    expect(result.rows[1].items[0]).not.toHaveProperty("attendees");
    expect(result.rows[2].items[0]).toMatchObject({
      description: "Private notes",
      location: "https://meet.example.test/room",
      attendees: ["guest@example.test"],
    });
    expect(JSON.stringify(result)).not.toContain("Must not leak");
    expect(JSON.stringify(result)).not.toContain("connectionId");
  });

  test("wrong or unselected calendars and forged attempt selection fail closed", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);

    await expect(
      broker.query(desktopQuery("readCalendar"), {
        attemptId: "attempt-1",
        selectedCalendarIds: [OTHER_CALENDAR],
        reads: [
          {
            kind: "searchEvents",
            calendarIds: [OTHER_CALENDAR],
            startMs: 0,
            endMs: 1_000,
            limit: 10,
          },
        ],
      }),
    ).rejects.toThrow("ASSISTANT_CALENDAR_NOT_AUTHORIZED");
  });

  test("progress and terminal settlement are idempotent and proposals stay pending", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    await broker.mutation(desktopMutation("recordProgress"), {
      attemptId: "attempt-1",
      state: "planning",
    });
    await broker.mutation(desktopMutation("recordProgress"), {
      attemptId: "attempt-1",
      state: "planning",
    });
    const value = {
      attemptId: "attempt-1",
      markdown: "I can create that.",
      proposals: [
        {
          kind: "create",
          calendarId: CALENDAR,
          summary: "Planning",
          time: { kind: "timed", startMs: 300, endMs: 400 },
          attendees: ["guest@example.test"],
        },
      ],
    };
    const first = await broker.mutation(
      desktopMutation("settleSuccess"),
      value,
    );
    const second = await broker.mutation(
      desktopMutation("settleSuccess"),
      value,
    );
    expect(second).toEqual(first);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("assistantActions").collect()).toMatchObject([
        { status: "pending", tool: "create_event" },
      ]);
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(
        0,
      );
      expect(await ctx.db.query("assistantAttempts").collect()).toMatchObject([
        { state: "completed", terminal: true },
      ]);
    });
    await expect(
      broker.mutation(desktopMutation("settleFailure"), {
        attemptId: "attempt-1",
        code: "process-failure",
        message: "conflicting late result",
      }),
    ).rejects.toThrow("ASSISTANT_ATTEMPT_ALREADY_SETTLED");
  });

  test("stale update proposal rejects atomically with no action or calendar operation", async () => {
    const t = convexTest(schema, modules);
    const { eventId } = await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    await expect(
      broker.mutation(desktopMutation("settleSuccess"), {
        attemptId: "attempt-1",
        markdown: "Move it.",
        proposals: [
          {
            kind: "update",
            calendarId: CALENDAR,
            eventId,
            expectedUpdatedAt: 6,
            expectedRevision: "revision_00000000000000000000000000000000",
            changes: {
              time: { kind: "timed", startMs: 300, endMs: 400 },
            },
          },
        ],
      }),
    ).rejects.toThrow("ASSISTANT_PROPOSAL_STALE");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("assistantActions").collect()).toHaveLength(0);
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(
        0,
      );
      expect(await ctx.db.query("assistantAttempts").collect()).toMatchObject([
        { state: "persisted", terminal: false },
      ]);
    });
  });

  test("a queued local edit invalidates the projected event revision", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    const read = await broker.query(desktopQuery("readCalendar"), {
      attemptId: "attempt-1",
      selectedCalendarIds: [CALENDAR],
      reads: [
        {
          kind: "getEvent",
          calendarId: CALENDAR,
          eventId: "local-event-1",
        },
      ],
    });
    const event = read.rows[0].items[0];
    expect(event.revision).toMatch(/^revision_[a-f0-9]{32}$/);

    await t.run(async (ctx) => {
      await ctx.db.insert("calendarOperations", {
        userId: USER,
        accountId: ACCOUNT,
        calendarId: CALENDAR,
        localEventId: "local-event-1",
        operationId: "operation_local_edit_001",
        idempotencyKey: "operation_local_edit_001",
        kind: "update",
        payload: { patch: { summary: "Locally edited" } },
        state: "pending",
        status: "pending",
        leaseReady: true,
        attemptCount: 0,
        createdAt: 600,
        updatedAt: 600,
      });
    });

    await expect(
      broker.mutation(desktopMutation("settleSuccess"), {
        attemptId: "attempt-1",
        markdown: "Update it.",
        proposals: [
          {
            kind: "update",
            calendarId: CALENDAR,
            eventId: "local-event-1",
            expectedUpdatedAt: 7,
            expectedRevision: event.revision,
            changes: { summary: "Assistant edit" },
          },
        ],
      }),
    ).rejects.toThrow("ASSISTANT_PROPOSAL_STALE");
  });

  test("a recurring-series change invalidates scoped proposal settlement", async () => {
    const t = convexTest(schema, modules);
    const { eventId } = await seedCalendar(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(eventId, { recurringEventId: "series-1" });
      await ctx.db.insert("recurringSeries", {
        userId: USER,
        calendarId: CALENDAR,
        googleEventId: "series-1",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
        sourceUpdatedMs: 7,
      });
    });
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    const read = await broker.query(desktopQuery("readCalendar"), {
      attemptId: "attempt-1",
      selectedCalendarIds: [CALENDAR],
      reads: [
        {
          kind: "getEvent",
          calendarId: CALENDAR,
          eventId: "local-event-1",
        },
      ],
    });
    const event = read.rows[0].items[0];
    expect(event.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    expect(event.seriesRevision).toMatch(/^series_[a-f0-9]{32}$/);

    await t.run(async (ctx) => {
      const series = await ctx.db
        .query("recurringSeries")
        .withIndex("by_user_and_calendar_and_googleEventId", (query) =>
          query
            .eq("userId", USER)
            .eq("calendarId", CALENDAR)
            .eq("googleEventId", "series-1"),
        )
        .unique();
      await ctx.db.patch(series!._id, {
        sourceUpdatedMs: 8,
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
      });
    });

    await expect(
      broker.mutation(desktopMutation("settleSuccess"), {
        attemptId: "attempt-1",
        markdown: "Update the series.",
        proposals: [
          {
            kind: "update",
            calendarId: CALENDAR,
            eventId: "local-event-1",
            expectedUpdatedAt: 7,
            expectedRevision: event.revision,
            expectedSeriesRevision: event.seriesRevision,
            changes: { summary: "Series edit" },
            scope: "allEvents",
          },
        ],
      }),
    ).rejects.toThrow("ASSISTANT_PROPOSAL_STALE");
  });

  test("an expired crashed attempt is settled before bounded takeover", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    const first = await beginAttempt(broker, "attempt-crashed");

    await expect(
      broker.mutation(desktopMutation("beginAttempt"), {
        attemptId: "attempt-before-expiry",
        text: "Too early",
        timeZone: "Europe/Paris",
        nowMs: 600_499,
      }),
    ).rejects.toThrow("ASSISTANT_BUSY");

    const replacement = await broker.mutation(desktopMutation("beginAttempt"), {
      attemptId: "attempt-replacement",
      text: "Try again after the crash",
      timeZone: "Europe/Paris",
      nowMs: 600_500,
    });
    expect(replacement.conversationId).toBe(first.conversationId);
    await t.run(async (ctx) => {
      const attempts = await ctx.db
        .query("assistantAttempts")
        .withIndex("by_thread", (query) =>
          query.eq("threadId", first.conversationId),
        )
        .collect();
      expect(attempts).toMatchObject([
        {
          attemptId: "attempt-crashed",
          state: "outcome-unknown",
          terminal: true,
          failureCode: "outcome-unknown",
        },
        {
          attemptId: "attempt-replacement",
          state: "persisted",
          terminal: false,
        },
      ]);
      expect(await ctx.db.query("assistantMessages").collect()).toHaveLength(4);
    });
  });

  test("active thread deletion preserves the attempt until it is terminal", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    const started = await beginAttempt(broker);
    const renderer = t.withIdentity(identity("renderer"));

    await renderer.mutation(api.assistantMaintenance.deleteThread, {
      threadId: started.conversationId,
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(started.conversationId)).not.toBeNull();
      expect(await ctx.db.query("assistantAttempts").collect()).toHaveLength(1);
      expect(await ctx.db.query("assistantMessages").collect()).toHaveLength(2);
    });
  });

  test("cancellation preserves committed messages and settles once", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    const first = await broker.mutation(
      desktopMutation("requestCancellation"),
      {
        attemptId: "attempt-1",
      },
    );
    const second = await broker.mutation(
      desktopMutation("requestCancellation"),
      {
        attemptId: "attempt-1",
      },
    );
    expect(second).toEqual(first);
    await expect(
      broker.mutation(desktopMutation("settleSuccess"), {
        attemptId: "attempt-1",
        markdown: "A late provider result.",
        proposals: [],
      }),
    ).rejects.toThrow("ASSISTANT_CANCEL_REQUESTED");
    await broker.mutation(desktopMutation("settleFailure"), {
      attemptId: "attempt-1",
      code: "process-failure",
      message: "A racing failure lost to cancellation.",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("assistantMessages").collect()).toHaveLength(2);
      expect(await ctx.db.query("assistantAttempts").collect()).toMatchObject([
        { state: "cancelled", cancelRequested: true, terminal: true },
      ]);
    });
  });

  test("confirmation revalidates the projected operation chain and keeps stale action pending", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    const read = await broker.query(desktopQuery("readCalendar"), {
      attemptId: "attempt-1",
      selectedCalendarIds: [CALENDAR],
      reads: [{ kind: "getEvent", calendarId: CALENDAR, eventId: "local-event-1" }],
    });
    const event = read.rows[0].items[0];
    const settled = await broker.mutation(desktopMutation("settleSuccess"), {
      attemptId: "attempt-1",
      markdown: "Rename it.",
      proposals: [{
        kind: "update",
        calendarId: CALENDAR,
        eventId: "local-event-1",
        expectedUpdatedAt: 7,
        expectedRevision: event.revision,
        changes: { summary: "Assistant edit" },
      }],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("calendarOperations", {
        userId: USER, accountId: ACCOUNT, calendarId: CALENDAR,
        localEventId: "local-event-1", operationId: "concurrent-edit",
        idempotencyKey: "concurrent-edit", kind: "update",
        payload: { patch: { summary: "Concurrent edit" } }, state: "pending",
        status: "pending", leaseReady: true, attemptCount: 0,
        createdAt: 700, updatedAt: 700,
      });
    });
    await expect(
      t.withIdentity(identity("renderer")).mutation(api.assistant.confirmAction, {
        actionId: settled.actionIds[0], decision: "confirm",
      }),
    ).rejects.toThrow("ASSISTANT_PROPOSAL_STALE");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(settled.actionIds[0])).toMatchObject({ status: "pending" });
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(1);
    });
  });

  test("confirmation revalidates current user, calendar selection/access, and series revision", async () => {
    const t = convexTest(schema, modules);
    const { eventId } = await seedCalendar(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(eventId, { recurringEventId: "series-1" });
      await ctx.db.insert("recurringSeries", {
        userId: USER, calendarId: CALENDAR, googleEventId: "series-1",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"], sourceUpdatedMs: 7,
      });
    });
    const broker = t.withIdentity(identity("desktop_broker"));
    await beginAttempt(broker);
    const read = await broker.query(desktopQuery("readCalendar"), {
      attemptId: "attempt-1", selectedCalendarIds: [CALENDAR],
      reads: [{ kind: "getEvent", calendarId: CALENDAR, eventId: "local-event-1" }],
    });
    const event = read.rows[0].items[0];
    const settled = await broker.mutation(desktopMutation("settleSuccess"), {
      attemptId: "attempt-1", markdown: "Rename the series.",
      proposals: [{
        kind: "update", calendarId: CALENDAR, eventId: "local-event-1",
        expectedUpdatedAt: 7, expectedRevision: event.revision,
        expectedSeriesRevision: event.seriesRevision,
        changes: { summary: "Series edit" }, scope: "allEvents",
      }],
    });
    const wrongIdentity = { ...identity("renderer"), subject: "wrong-user", tokenIdentifier: `${LOCAL_AUTH_ISSUERS.test}|wrong-user` };
    await expect(t.withIdentity(wrongIdentity).mutation(api.assistant.confirmAction, {
      actionId: settled.actionIds[0], decision: "confirm",
    })).rejects.toThrow("LOCAL_IDENTITY_REQUIRED");
    await t.run(async (ctx) => {
      const series = (await ctx.db.query("recurringSeries").collect())[0]!;
      await ctx.db.patch(series._id, { sourceUpdatedMs: 8 });
    });
    await expect(t.withIdentity(identity("renderer")).mutation(api.assistant.confirmAction, {
      actionId: settled.actionIds[0], decision: "confirm",
    })).rejects.toThrow("ASSISTANT_PROPOSAL_STALE");
    await t.run(async (ctx) => {
      const calendar = (await ctx.db.query("calendars").collect()).find((row) => row.googleCalendarId === CALENDAR)!;
      const series = (await ctx.db.query("recurringSeries").collect())[0]!;
      await ctx.db.patch(series._id, { sourceUpdatedMs: 7 });
      await ctx.db.patch(calendar._id, { accessRole: "reader", selected: false });
    });
    await expect(t.withIdentity(identity("renderer")).mutation(api.assistant.confirmAction, {
      actionId: settled.actionIds[0], decision: "confirm",
    })).rejects.toThrow("ASSISTANT_CALENDAR_NOT_AUTHORIZED");
  });

  test("concurrent confirmation is deterministic and an accept-discard race has one terminal result", async () => {
    const t = convexTest(schema, modules);
    await seedCalendar(t);
    const makeAction = () => t.run(async (ctx) => {
      const threadId = await ctx.db.insert("assistantThreads", {
        userId: USER, title: "Race", createdAt: 1, lastMessageAt: 1,
      });
      return ctx.db.insert("assistantActions", {
        threadId, userId: USER, toolCallId: crypto.randomUUID(), tool: "create_event",
        input: JSON.stringify({ kind: "create", calendarId: CALENDAR, summary: "Race", time: { kind: "timed", startMs: 1_000, endMs: 2_000 }, timeZone: "Europe/Paris" }),
        preview: "Create Race", status: "pending", createdAt: 1,
      });
    });
    const renderer = t.withIdentity(identity("renderer"));
    const actionId = await makeAction();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const [first, second] = await Promise.all([
      renderer.mutation(api.assistant.confirmAction, { actionId, decision: "confirm" }),
      renderer.mutation(api.assistant.confirmAction, { actionId, decision: "confirm" }),
    ]);
    expect(second).toEqual(first);
    const racingActionId = await makeAction();
    const race = await Promise.allSettled([
      renderer.mutation(api.assistant.confirmAction, { actionId: racingActionId, decision: "confirm" }),
      renderer.mutation(api.assistant.confirmAction, { actionId: racingActionId, decision: "discard" }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await t.run(async (ctx) => {
      const terminal = await ctx.db.get(racingActionId);
      expect(["applied", "rejected"]).toContain(terminal?.status);
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(
        terminal?.status === "applied" ? 2 : 1,
      );
    });
    fetchSpy.mockRestore();
  });

  test("confirmed recurring update and delete preserve their validated scopes", async () => {
    const t = convexTest(schema, modules);
    const { eventId } = await seedCalendar(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(eventId, { recurringEventId: "series-scope" });
      await ctx.db.insert("recurringSeries", {
        userId: USER, calendarId: CALENDAR, googleEventId: "series-scope",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"], sourceUpdatedMs: 7,
      });
    });
    const broker = t.withIdentity(identity("desktop_broker"));
    const renderer = t.withIdentity(identity("renderer"));
    await beginAttempt(broker, "scope-update");
    const firstRead = await broker.query(desktopQuery("readCalendar"), {
      attemptId: "scope-update", selectedCalendarIds: [CALENDAR],
      reads: [{ kind: "getEvent", calendarId: CALENDAR, eventId: "local-event-1" }],
    });
    const first = firstRead.rows[0].items[0];
    const update = await broker.mutation(desktopMutation("settleSuccess"), {
      attemptId: "scope-update", markdown: "Update all.",
      proposals: [{ kind: "update", calendarId: CALENDAR, eventId: "local-event-1",
        expectedUpdatedAt: 7, expectedRevision: first.revision,
        expectedSeriesRevision: first.seriesRevision, changes: { summary: "All" }, scope: "allEvents" }],
    });
    await renderer.mutation(api.assistant.confirmAction, { actionId: update.actionIds[0], decision: "confirm" });
    await beginAttempt(broker, "scope-delete");
    const secondRead = await broker.query(desktopQuery("readCalendar"), {
      attemptId: "scope-delete", selectedCalendarIds: [CALENDAR],
      reads: [{ kind: "getEvent", calendarId: CALENDAR, eventId: "local-event-1" }],
    });
    const second = secondRead.rows[0].items[0];
    const deletion = await broker.mutation(desktopMutation("settleSuccess"), {
      attemptId: "scope-delete", markdown: "Delete following.",
      proposals: [{ kind: "delete", calendarId: CALENDAR, eventId: "local-event-1",
        expectedUpdatedAt: 7, expectedRevision: second.revision,
        expectedSeriesRevision: second.seriesRevision, scope: "thisAndFollowing" }],
    });
    await renderer.mutation(api.assistant.confirmAction, { actionId: deletion.actionIds[0], decision: "confirm" });
    await t.run(async (ctx) => {
      const operations = await ctx.db.query("calendarOperations").collect();
      expect(operations).toHaveLength(2);
      expect(operations[0]?.payload).toMatchObject({ patch: { recurrenceScope: "allEvents" } });
      expect(operations[1]?.payload).toMatchObject({ recurrenceScope: "thisAndFollowing" });
    });
  });
});
