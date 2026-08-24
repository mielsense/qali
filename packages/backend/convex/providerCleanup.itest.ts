/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import { contractSchema, legacyMigrationSchema } from "./schema";
import { LOCAL_AUTH_ISSUERS, LOCAL_AUTH_SUBJECT } from "./domains/desktop/identity";

const modules = import.meta.glob("./**/*.ts");
const USER = LOCAL_AUTH_SUBJECT;

function cleanupMutation(): FunctionReference<"mutation"> {
  return (
    api as unknown as Record<string, Record<string, FunctionReference<"mutation">>>
  ).desktopCalendar!.cleanupLegacyProviderReferences!;
}

describe("legacy provider cleanup migration", () => {
  test("cleans a seeded legacy database while preserving calendar attendee names", async () => {
    const t = convexTest(legacyMigrationSchema, modules);
    await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("calendarConnections", {
        userId: USER,
        provider: "google",
        credentialRef: "better-auth-account",
        capabilities: { contacts: true, idempotentCreate: false },
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("syncState", {
        userId: USER,
        contactsSyncToken: "contacts-token",
        status: "idle",
      });
      await ctx.db.insert("connectionSyncState", {
        connectionId,
        userId: USER,
        contactsCursor: "contacts-cursor",
        status: "idle",
      });
      await ctx.db.insert("contacts", {
        userId: USER,
        resourceName: "people/123",
        displayName: "Provider profile",
        emails: ["guest@example.test"],
        phones: [],
        photoUrl: "https://people.googleapis.test/photo",
      });
      await ctx.db.insert("people", {
        userId: USER,
        email: "guest@example.test",
        displayName: "Calendar Guest",
        photoUrl: "https://people.googleapis.test/photo",
        sources: ["connection", "other", "attendee"],
        otherSyncGeneration: 7,
        updatedAt: 2,
      });
      await ctx.db.insert("people", {
        userId: USER,
        email: "provider-only@example.test",
        displayName: "Provider Only",
        sources: ["connection"],
        updatedAt: 2,
      });
    });

    const broker = t.withIdentity({
      issuer: LOCAL_AUTH_ISSUERS.test,
      subject: USER,
      tokenIdentifier: `${LOCAL_AUTH_ISSUERS.test}|${USER}`,
      email: "local@qali.app",
      name: "Qali User",
      role: "desktop_broker",
    });
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages += 1) {
      const result = await broker.mutation(cleanupMutation(), { cursor });
      if (result.done) break;
      cursor = result.cursor;
    }

    const normalized = await t.run(async (ctx) => {
      const connections = await ctx.db.query("calendarConnections").collect();
      expect(connections).toHaveLength(1);
      expect(connections[0]).not.toHaveProperty("credentialRef");
      expect(connections[0]).not.toHaveProperty("capabilities");
      expect(await ctx.db.query("syncState").collect()).toEqual([]);
      expect(await ctx.db.query("connectionSyncState").collect()).toEqual([]);
      expect(await ctx.db.query("contacts").collect()).toEqual([]);
      expect(await ctx.db.query("people").collect()).toEqual([
        expect.objectContaining({
          email: "guest@example.test",
          displayName: "Calendar Guest",
          sources: ["attendee"],
        }),
      ]);
      expect((await ctx.db.query("people").collect())[0]).not.toHaveProperty("photoUrl");
      expect((await ctx.db.query("people").collect())[0]).not.toHaveProperty("otherSyncGeneration");
      return { connection: connections[0]!, person: (await ctx.db.query("people").collect())[0]! };
    });

    const contracted = convexTest(contractSchema, modules);
    await contracted.run(async (ctx) => {
      const { _id: _connectionId, _creationTime: _connectionCreation, ...connection } = normalized.connection;
      const { _id: _personId, _creationTime: _personCreation, ...person } = normalized.person;
      await ctx.db.insert("calendarConnections", connection);
      await ctx.db.insert("people", person);
    });
  });
});
