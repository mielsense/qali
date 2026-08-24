/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "../../_generated/api";
import schema from "../../schema";
import { LOCAL_AUTH_ISSUERS, LOCAL_AUTH_SUBJECT } from "../desktop/identity";

const modules = import.meta.glob("../../**/*.ts");
const USER = LOCAL_AUTH_SUBJECT;
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

async function seedWritableCalendar(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId: USER,
      provider: "google",
      providerAccountId: "account_legacy",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("calendars", {
      userId: USER,
      googleCalendarId: CALENDAR,
      providerCalendarId: CALENDAR,
      accountId: "account_legacy",
      connectionId,
      accessRole: "owner",
      primary: true,
      selected: true,
    });
    const eventId = await ctx.db.insert("events", {
      userId: USER,
      localEventId: "legacy-event",
      accountId: "account_legacy",
      connectionId,
      calendarId: CALENDAR,
      googleEventId: "remote-legacy",
      remoteEtag: "etag-legacy",
      summary: "Original",
      startMs: 10_000,
      endMs: 20_000,
      allDay: false,
      status: "confirmed",
      googleUpdatedMs: 7,
      organizer: { self: true },
      syncState: "synced",
    });
    const threadId = await ctx.db.insert("assistantThreads", {
      userId: USER,
      title: "Compatibility",
      createdAt: 1,
      lastMessageAt: 1,
    });
    return { eventId, threadId };
  });
}

describe("assistant writes commit to the local ledger", () => {
  test.each([
    ["create_event", (eventId: string) => ({ summary: "Legacy create", time: { kind: "timed", startMs: 30_000, endMs: 40_000 }, timeZone: "Europe/Paris" }), "create"],
    ["update_event", (eventId: string) => ({ eventId, summary: "Legacy update", timeZone: "Europe/Paris" }), "update"],
    ["move_event", (eventId: string) => ({ eventId, time: { kind: "timed", startMs: 30_000, endMs: 40_000 }, timeZone: "Europe/Paris" }), "update"],
    ["delete_event", (eventId: string) => ({ eventId, scope: "thisEvent", timeZone: "Europe/Paris" }), "delete"],
  ] as const)("confirms hosted legacy %s proposals through the local ledger", async (tool, inputFor, expectedKind) => {
    const t = convexTest(schema, modules);
    const { eventId, threadId } = await seedWritableCalendar(t);
    const actionId = await t.run((ctx) => ctx.db.insert("assistantActions", {
      threadId,
      userId: USER,
      toolCallId: `legacy-${tool}`,
      tool,
      input: JSON.stringify(inputFor(String(eventId))),
      preview: tool,
      status: "pending",
      createdAt: 1,
    }));
    await t.withIdentity(rendererIdentity()).mutation(api.assistant.confirmAction, {
      actionId,
      decision: "confirm",
    });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(actionId)).toMatchObject({ status: "applied" });
      expect(await ctx.db.query("calendarOperations").collect()).toMatchObject([
        { kind: expectedKind, state: "pending" },
      ]);
    });
  });

  test("desktop recurrence confirmation uses range and zone validation", async () => {
    for (const proposal of [
      {
        summary: "Wrong weekday",
        time: { kind: "allDay", startDate: "2026-08-03", endDate: "2026-08-04" },
        recurrence: { frequency: "weekly", weekdays: ["tuesday"] },
      },
      {
        summary: "End before start",
        time: { kind: "allDay", startDate: "2026-08-03", endDate: "2026-08-04" },
        recurrence: { frequency: "daily", end: { kind: "onDate", date: "2026-08-02" } },
      },
    ] as const) {
      const t = convexTest(schema, modules);
      const { threadId } = await seedWritableCalendar(t);
      const actionId = await t.run((ctx) => ctx.db.insert("assistantActions", {
        threadId, userId: USER, toolCallId: proposal.summary, tool: "create_event",
        input: JSON.stringify({ kind: "create", calendarId: CALENDAR, ...proposal, timeZone: "Europe/Paris" }),
        preview: proposal.summary, status: "pending", createdAt: 1,
      }));
      await expect(t.withIdentity(rendererIdentity()).mutation(api.assistant.confirmAction, {
        actionId, decision: "confirm",
      })).rejects.toThrow(/first occurrence|end date/);
      await t.run(async (ctx) => {
        expect(await ctx.db.get(actionId)).toMatchObject({ status: "pending" });
        expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(0);
      });
    }
  });

  test.each([
    [
      { kind: "allDay", startDate: "2026-08-03", endDate: "2026-08-04" },
      "RRULE:FREQ=DAILY;UNTIL=20260810",
    ],
    [
      { kind: "timed", startMs: Date.parse("2026-08-03T08:00:00.000Z"), endMs: Date.parse("2026-08-03T09:00:00.000Z") },
      "RRULE:FREQ=DAILY;UNTIL=20260810T215959Z",
    ],
  ] as const)("compiles confirmed desktop recurrence with all-day/timed UNTIL semantics", async (time, expected) => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedWritableCalendar(t);
    const actionId = await t.run((ctx) => ctx.db.insert("assistantActions", {
      threadId, userId: USER, toolCallId: expected, tool: "create_event",
      input: JSON.stringify({
        kind: "create", calendarId: CALENDAR, summary: "Repeat", time,
        recurrence: { frequency: "daily", end: { kind: "onDate", date: "2026-08-10" } },
        timeZone: "Europe/Paris",
      }),
      preview: "Repeat", status: "pending", createdAt: 1,
    }));
    await t.withIdentity(rendererIdentity()).mutation(api.assistant.confirmAction, {
      actionId, decision: "confirm",
    });
    await t.run(async (ctx) => {
      const [operation] = await ctx.db.query("calendarOperations").collect();
      expect(operation?.payload).toMatchObject({ event: { recurrence: [expected] } });
    });
  });

  test("confirms a stored desktop proposal atomically and idempotently", async () => {
    const t = convexTest(schema, modules);
    const actionId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        providerAccountId: "account_001",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: CALENDAR,
        providerCalendarId: CALENDAR,
        accountId: "account_001",
        connectionId,
        accessRole: "owner",
        primary: true,
        selected: true,
      });
      const threadId = await ctx.db.insert("assistantThreads", {
        userId: USER,
        title: "Desktop proposal",
        createdAt: 1,
        lastMessageAt: 1,
      });
      return ctx.db.insert("assistantActions", {
        threadId,
        userId: USER,
        toolCallId: "attempt-1-0",
        tool: "create_event",
        input: JSON.stringify({
          kind: "create",
          calendarId: CALENDAR,
          summary: "Review",
          time: { kind: "timed", startMs: 10_000, endMs: 20_000 },
          timeZone: "Europe/Paris",
        }),
        preview: "Create Review",
        attemptCount: 0,
        status: "pending",
        createdAt: 1,
      });
    });
    const renderer = t.withIdentity(rendererIdentity());
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const first = await renderer.mutation(api.assistant.confirmAction, {
      actionId,
      decision: "confirm",
    });
    const second = await renderer.mutation(api.assistant.confirmAction, {
      actionId,
      decision: "confirm",
    });

    expect(second).toEqual(first);
    expect(fetchSpy).not.toHaveBeenCalled();
    await t.run(async (ctx) => {
      expect(await ctx.db.get(actionId)).toMatchObject({
        status: "applied",
        operationId: first.operationId,
      });
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(1);
    });
    fetchSpy.mockRestore();
  });

  test("discarding a stored desktop proposal is idempotent and enqueues nothing", async () => {
    const t = convexTest(schema, modules);
    const actionId = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("assistantThreads", {
        userId: USER,
        title: "Desktop proposal",
        createdAt: 1,
        lastMessageAt: 1,
      });
      return ctx.db.insert("assistantActions", {
        threadId,
        userId: USER,
        toolCallId: "attempt-2-0",
        tool: "delete_event",
        input: JSON.stringify({ kind: "delete", calendarId: CALENDAR, eventId: "event" }),
        preview: "Delete event",
        status: "pending",
        createdAt: 1,
      });
    });
    const renderer = t.withIdentity(rendererIdentity());
    const first = await renderer.mutation(api.assistant.confirmAction, {
      actionId,
      decision: "discard",
    });
    expect(
      await renderer.mutation(api.assistant.confirmAction, {
        actionId,
        decision: "discard",
      }),
    ).toEqual(first);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(actionId)).toMatchObject({ status: "rejected" });
      expect(await ctx.db.query("calendarOperations").collect()).toHaveLength(0);
    });
  });

});
