/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "../../_generated/api";
import schema from "../../schema";
import { LOCAL_AUTH_ISSUERS, LOCAL_AUTH_SUBJECT } from "../desktop/identity";

const modules = import.meta.glob("../../**/*.ts");
const USER = LOCAL_AUTH_SUBJECT;

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

async function seedCalendar(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) =>
    ctx.db.insert("calendars", {
      userId: USER,
      googleCalendarId: "primary@example.com",
      accountId: "account_001",
      backgroundColor: "#039be5",
      selected: true,
    }),
  );
}

describe("calendar display preferences", () => {
  test("the renderer can set and reset a bounded local color", async () => {
    const t = convexTest(schema, modules);
    const calendarId = await seedCalendar(t);
    const renderer = t.withIdentity(identity("renderer"));

    await renderer.mutation(api.calendar.setCalendarColor, {
      calendarId,
      color: "event-7",
    });
    expect(await t.run((ctx) => ctx.db.get(calendarId))).toMatchObject({
      colorOverride: "event-7",
    });

    await renderer.mutation(api.calendar.setCalendarColor, {
      calendarId,
      color: null,
    });
    expect((await t.run((ctx) => ctx.db.get(calendarId)))?.colorOverride).toBe(
      undefined,
    );
  });

  test("Google refreshes preserve the local color override", async () => {
    const t = convexTest(schema, modules);
    const calendarId = await seedCalendar(t);
    const renderer = t.withIdentity(identity("renderer"));
    const broker = t.withIdentity(identity("desktop_broker"));
    await renderer.mutation(api.calendar.setCalendarColor, {
      calendarId,
      color: "event-3",
    });

    await broker.mutation(api.desktopCalendar.applyRemoteCalendars, {
      accountId: "account_001",
      calendars: [
        {
          id: "primary@example.com",
          backgroundColor: "#33b679",
          selected: true,
          writable: true,
        },
      ],
    });

    expect(await t.run((ctx) => ctx.db.get(calendarId))).toMatchObject({
      backgroundColor: "#33b679",
      colorOverride: "event-3",
    });
  });

  test("forged colors and cross-user rows fail closed", async () => {
    const t = convexTest(schema, modules);
    const calendarId = await seedCalendar(t);
    const renderer = t.withIdentity(identity("renderer"));

    await expect(
      renderer.mutation(api.calendar.setCalendarColor, {
        calendarId,
        color: "url(https://example.com)",
      } as never),
    ).rejects.toThrow();

    const other = await t.run((ctx) =>
      ctx.db.insert("calendars", {
        userId: "other-user",
        googleCalendarId: "other@example.com",
        selected: true,
      }),
    );
    await expect(
      renderer.mutation(api.calendar.setCalendarColor, {
        calendarId: other,
        color: "event-1",
      }),
    ).rejects.toThrow("Calendar not found");
  });
});
