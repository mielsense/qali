/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "./schema";
import { ensureGoogleConnection } from "./domains/calendar/connections";

const modules = import.meta.glob("./**/*.ts");

/**
 * The connection tables are deployed empty and queried by nothing yet, so there
 * are no functions to exercise. This smoke test just proves the intended row
 * shapes are insertable and linkable — a record of what the Stage 5 backfill
 * will write, and a guard against a schema drift that would break it.
 */
describe("connection model expand", () => {
  test("legacy callers cannot guess between multiple active Google accounts", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.run(async (ctx) => {
        for (const accountId of ["gacc_a", "gacc_b"]) {
          await ctx.db.insert("calendarConnections", {
            userId: "user_multi",
            provider: "google",
            accountId,
            providerAccountId: `sub-${accountId}`,
            status: "active",
            createdAt: 1,
            updatedAt: 1,
          });
        }
        return ensureGoogleConnection(ctx, "user_multi");
      }),
    ).rejects.toThrow("GOOGLE_ACCOUNT_SELECTION_REQUIRED");
  });

  test("a local connection links its durable operation rows", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_conn";

    const ids = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("calendarOperations", {
        connectionId,
        userId,
        idempotencyKey: "op-1",
        kind: "create",
        status: "pending",
        createdAt: 1,
        updatedAt: 1,
      });
      return { connectionId };
    });

    await t.run(async (ctx) => {
      const connection = await ctx.db.get(ids.connectionId);
      expect(connection?.provider).toBe("google");

      const op = await ctx.db
        .query("calendarOperations")
        .withIndex("by_connection_and_key", (q) =>
          q.eq("connectionId", ids.connectionId).eq("idempotencyKey", "op-1"),
        )
        .unique();
      expect(op?.status).toBe("pending");
    });
  });

  test("a dual-written event is reachable through the staged neutral-id index", async () => {
    const t = convexTest(schema, modules);
    const userId = "user_dual";

    const connectionId = await t.run((ctx) =>
      ctx.db.insert("calendarConnections", {
        userId,
        provider: "google",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    // An event as the backfill/dual-write path will write it: legacy Google
    // columns AND the neutral mirror side by side.
    await t.run((ctx) =>
      ctx.db.insert("events", {
        userId,
        calendarId: "primary",
        googleEventId: "g-evt-1",
        startMs: 1_000,
        endMs: 2_000,
        allDay: false,
        status: "confirmed",
        googleUpdatedMs: 1_000,
        connectionId,
        providerEventId: "g-evt-1",
        providerUpdatedMs: 1_000,
      }),
    );

    const found = await t.run((ctx) =>
      ctx.db
        .query("events")
        .withIndex("by_connection_and_providerEventId", (q) =>
          q.eq("connectionId", connectionId).eq("providerEventId", "g-evt-1"),
        )
        .unique(),
    );
    // Both id views resolve the same row — the invariant dual-read depends on.
    expect(found?.googleEventId).toBe("g-evt-1");
    expect(found?.providerEventId).toBe(found?.googleEventId);
  });
});
