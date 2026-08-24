import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { assistantTables } from "./domains/assistant/tables";
import { calendarTables } from "./domains/calendar/tables";
import { marketingTables } from "./domains/marketing/tables";
import { legacyPeopleTables, peopleTables } from "./domains/people/tables";
import { schemaPhase } from "./schemaPhase";

// The event validators (attendee/person/googleEvent/eventDoc) live in
// domains/calendar/validators.ts so the schema and the calendar write path can
// share them without a circular import back through this file.

// assistantBlockValidator lives in domains/assistant/validators.ts.

const commonTables = {
  // Calendar domain tables — calendars / events / sharedEvents / sharedCalendars /
  // recurringSeries (see domains/calendar/tables.ts).
  ...calendarTables,

  // Fixed-window counters guarding anonymous marketing requests. A Convex
  // mutation has no client IP to key on, so these use stable request keys.
  publicRateLimits: defineTable({
    key: v.string(),
    windowStartMs: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // Assistant domain tables — threads / state / messages / actions (see
  // domains/assistant/tables.ts).
  ...assistantTables,

  // Marketing domain tables — the public waitlist (see domains/marketing/tables.ts).
  ...marketingTables,

};

const contractConnectionTable = defineTable({
    userId: v.string(),
    provider: v.literal("google"),
    // Stable local key derived from Google's immutable `sub`. Optional only
    // while the expand/backfill deployment is accepting legacy rows.
    accountId: v.optional(v.string()),
    // Google's immutable OpenID Connect `sub`, never an email address.
    providerAccountId: v.optional(v.string()),
    accountEmail: v.optional(v.string()),
    legacyMigrationState: v.optional(
      v.union(v.literal("claimed"), v.literal("detached"), v.literal("complete")),
    ),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("error"),
    ),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_provider", ["userId", "provider"])
    .index("by_user_provider_account", ["userId", "provider", "accountId"])
    .index("by_user_provider_subject", [
      "userId",
      "provider",
      "providerAccountId",
    ]);

const legacyConnectionTable = defineTable({
  userId: v.string(),
  provider: v.union(v.literal("google"), v.literal("microsoft")),
  accountId: v.optional(v.string()),
  providerAccountId: v.optional(v.string()),
  accountEmail: v.optional(v.string()),
  legacyMigrationState: v.optional(
    v.union(v.literal("claimed"), v.literal("detached"), v.literal("complete")),
  ),
  credentialRef: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("paused"), v.literal("error")),
  capabilities: v.optional(v.object({
    contacts: v.boolean(),
    idempotentCreate: v.boolean(),
  })),
  lastError: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_user", ["userId"])
  .index("by_user_and_provider", ["userId", "provider"])
  .index("by_user_provider_account", ["userId", "provider", "accountId"])
  .index("by_user_provider_subject", [
    "userId",
    "provider",
    "providerAccountId",
  ]);

const legacySyncState = defineTable({
  userId: v.string(),
  contactsSyncToken: v.optional(v.string()),
  lastContactsSyncAt: v.optional(v.number()),
  otherContactsSyncToken: v.optional(v.string()),
  lastOtherContactsSyncAt: v.optional(v.number()),
  contactsSyncGeneration: v.optional(v.number()),
  otherContactsSyncGeneration: v.optional(v.number()),
  status: v.union(v.literal("idle"), v.literal("syncing"), v.literal("error")),
  lastError: v.optional(v.string()),
  nextSyncDueAt: v.optional(v.number()),
  syncIntervalMs: v.optional(v.number()),
  syncLeaseExpiresAt: v.optional(v.number()),
  syncAttemptId: v.optional(v.string()),
})
  .index("by_user", ["userId"])
  .index("by_nextSyncDueAt", ["nextSyncDueAt"]);

const legacyConnectionSyncState = defineTable({
  connectionId: v.id("calendarConnections"),
  userId: v.string(),
  contactsCursor: v.optional(v.string()),
  otherContactsCursor: v.optional(v.string()),
  contactsGeneration: v.optional(v.number()),
  otherContactsGeneration: v.optional(v.number()),
  status: v.union(v.literal("idle"), v.literal("syncing"), v.literal("error")),
  lastError: v.optional(v.string()),
  nextSyncDueAt: v.optional(v.number()),
  syncIntervalMs: v.optional(v.number()),
  syncLeaseExpiresAt: v.optional(v.number()),
  syncAttemptId: v.optional(v.string()),
})
  .index("by_connection", ["connectionId"])
  .index("by_user", ["userId"])
  .index("by_nextSyncDueAt", ["nextSyncDueAt"]);

export const contractSchema = defineSchema({
  ...commonTables,
  ...peopleTables,
  calendarConnections: contractConnectionTable,
});

export const legacyMigrationSchema = defineSchema({
  ...commonTables,
  ...legacyPeopleTables,
  syncState: legacySyncState,
  calendarConnections: legacyConnectionTable,
  connectionSyncState: legacyConnectionSyncState,
});

export default schemaPhase === "expand" ? legacyMigrationSchema : contractSchema;
