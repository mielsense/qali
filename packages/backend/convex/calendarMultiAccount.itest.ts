/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import { LOCAL_AUTH_ISSUERS, LOCAL_AUTH_SUBJECT } from "./domains/desktop/identity";

const modules = import.meta.glob("./**/*.ts");
const USER = LOCAL_AUTH_SUBJECT;
const HOLIDAY = "en.fr#holiday@group.v.calendar.google.com";
const START_MS = Date.parse("2026-12-24T00:00:00.000Z");
const END_MS = Date.parse("2026-12-26T00:00:00.000Z");

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

describe("multi-account shared calendar cache", () => {
  test("uses raw holiday ids for range, assistant, and direct shared-event reads", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      for (const [accountId, calendarId] of [
        ["gacc_a", "gcal_holiday_a"],
        ["gacc_b", "gcal_holiday_b"],
      ] as const) {
        const connectionId = await ctx.db.insert("calendarConnections", {
          userId: USER,
          provider: "google",
          accountId,
          providerAccountId: `sub-${accountId}`,
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("calendars", {
          userId: USER,
          googleCalendarId: calendarId,
          calendarKey: calendarId,
          providerCalendarId: HOLIDAY,
          accountId,
          connectionId,
          selected: true,
          accessRole: "reader",
        });
      }
      const personalCalendarId = "gcal_personal_a";
      await ctx.db.insert("calendars", {
        userId: USER,
        googleCalendarId: personalCalendarId,
        calendarKey: personalCalendarId,
        providerCalendarId: "primary",
        accountId: "gacc_a",
        selected: true,
        accessRole: "owner",
      });
      const personalEventId = await ctx.db.insert("events", {
        userId: USER,
        accountId: "gacc_a",
        calendarId: personalCalendarId,
        googleEventId: "personal-event",
        startMs: START_MS + 60 * 60_000,
        endMs: START_MS + 2 * 60 * 60_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1,
      });
      const sharedEventId = await ctx.db.insert("sharedEvents", {
        calendarId: HOLIDAY,
        googleEventId: "holiday-event",
        summary: "Christmas Day",
        startMs: START_MS,
        endMs: END_MS,
        allDay: true,
        status: "confirmed",
        googleUpdatedMs: 1,
      });
      return { personalEventId, sharedEventId };
    });
    const renderer = t.withIdentity(rendererIdentity());

    const range = await renderer.query(api.calendar.listEventsInRange, {
      startMs: START_MS,
      endMs: END_MS,
    });
    expect(range.map((event) => event._id)).toEqual([
      seeded.sharedEventId,
      seeded.personalEventId,
    ]);

    const assistant = await t.query(
      internal.calendar.listSharedEventsForAssistant,
      { userId: USER, startMs: START_MS, endMs: END_MS },
    );
    expect(assistant).toMatchObject([
      { _id: seeded.sharedEventId, calendarId: HOLIDAY },
    ]);

    await expect(
      renderer.query(api.calendar.getEventById, {
        eventId: seeded.sharedEventId,
      }),
    ).resolves.toMatchObject({
      _id: seeded.sharedEventId,
      calendarId: HOLIDAY,
    });
  });
});
