import { v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import { enqueueCalendarOperation } from "./domains/calendar/operations";
import {
  applyRemotePage as applyRemotePageHandler,
  applyRemoteCalendars as applyRemoteCalendarsHandler,
  attachGoogleAccount as attachGoogleAccountHandler,
  beginRemoteFullSync as beginRemoteFullSyncHandler,
  completeRemoteSync as completeRemoteSyncHandler,
  cleanupLegacyProviderReferences as cleanupLegacyProviderReferencesHandler,
  exportLocalSnapshot as exportLocalSnapshotHandler,
  heartbeatLease as heartbeatLeaseHandler,
  leaseOperations as leaseOperationsHandler,
  recordRemoteAmbiguous as recordRemoteAmbiguousHandler,
  recordRemoteConflict as recordRemoteConflictHandler,
  recordRemoteFailure as recordRemoteFailureHandler,
  recordRemoteRetry as recordRemoteRetryHandler,
  recordRemoteSuccess as recordRemoteSuccessHandler,
  releaseLease as releaseLeaseHandler,
  syncState as syncStateHandler,
} from "./domains/desktop/calendarBroker";
import {
  auditGoogleAccountMigration as auditGoogleAccountMigrationHandler,
  migrateLegacyGoogleData as migrateLegacyGoogleDataHandler,
} from "./domains/desktop/multiAccountMigration";
import {
  calendarEventSnapshotValidator,
  calendarOperationPayloadValidator,
} from "./domains/calendar/validators";

export const enqueueOperation = internalMutation({
  args: {
    userId: v.string(),
    operationId: v.string(),
    accountId: v.string(),
    calendarId: v.string(),
    localEventId: v.string(),
    remoteEventId: v.optional(v.string()),
    kind: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("move"),
      v.literal("respond"),
      v.literal("delete"),
    ),
    payload: calendarOperationPayloadValidator,
    baseRemoteSnapshot: v.optional(calendarEventSnapshotValidator),
    baseRemoteEtag: v.optional(v.string()),
    predecessorOperationId: v.optional(v.string()),
  },
  handler: (ctx, args) => {
    const { userId, ...command } = args;
    return enqueueCalendarOperation(ctx, userId, command);
  },
});

export const attachGoogleAccount = mutation({
  args: {
    accountId: v.string(),
    providerAccountId: v.string(),
    accountEmail: v.optional(v.string()),
  },
  handler: (ctx, args) => attachGoogleAccountHandler(ctx, args),
});

export const migrateLegacyGoogleData = mutation({
  args: {
    accountId: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    cursor: v.optional(v.string()),
  },
  handler: (ctx, args) => migrateLegacyGoogleDataHandler(ctx, args),
});

export const auditGoogleAccountMigration = query({
  args: { accountId: v.string(), cursor: v.optional(v.string()) },
  handler: (ctx, args) => auditGoogleAccountMigrationHandler(ctx, args),
});

export const leaseOperations = mutation({
  args: {
    accountId: v.string(),
    leaseId: v.string(),
    limit: v.optional(v.number()),
    leaseDurationMs: v.optional(v.number()),
  },
  handler: (ctx, args) => leaseOperationsHandler(ctx, args),
});

export const syncState = query({
  args: { accountId: v.string() },
  handler: (ctx, args) => syncStateHandler(ctx, args),
});

export const exportLocalSnapshot = query({
  args: {},
  handler: (ctx) => exportLocalSnapshotHandler(ctx),
});

export const cleanupLegacyProviderReferences = mutation({
  args: { cursor: v.optional(v.string()) },
  handler: (ctx, args) => cleanupLegacyProviderReferencesHandler(ctx, args),
});

export const applyRemoteCalendars = mutation({
  args: {
    accountId: v.string(),
    calendars: v.array(
      v.object({
        id: v.string(),
        summary: v.optional(v.string()),
        summaryOverride: v.optional(v.string()),
        backgroundColor: v.optional(v.string()),
        foregroundColor: v.optional(v.string()),
        primary: v.optional(v.boolean()),
        accessRole: v.optional(v.string()),
        timeZone: v.optional(v.string()),
        selected: v.optional(v.boolean()),
        hidden: v.optional(v.boolean()),
        writable: v.boolean(),
      }),
    ),
  },
  handler: (ctx, args) => applyRemoteCalendarsHandler(ctx, args),
});

export const beginRemoteFullSync = mutation({
  args: {
    accountId: v.string(),
    calendarId: v.string(),
    providerCalendarId: v.optional(v.string()),
  },
  handler: (ctx, args) => beginRemoteFullSyncHandler(ctx, args),
});

export const heartbeatLease = mutation({
  args: {
    leaseId: v.string(),
    leaseDurationMs: v.optional(v.number()),
  },
  handler: (ctx, args) => heartbeatLeaseHandler(ctx, args),
});

export const recordRemoteSuccess = mutation({
  args: {
    operationId: v.string(),
    leaseId: v.string(),
    remoteSnapshot: v.optional(calendarEventSnapshotValidator),
    remoteEtag: v.optional(v.string()),
    remoteUpdatedAt: v.optional(v.number()),
    remoteReceipt: v.optional(v.string()),
  },
  handler: (ctx, args) => recordRemoteSuccessHandler(ctx, args),
});

export const recordRemoteAmbiguous = mutation({
  args: {
    operationId: v.string(),
    leaseId: v.string(),
    safeError: v.string(),
    retryAt: v.optional(v.number()),
  },
  handler: (ctx, args) => recordRemoteAmbiguousHandler(ctx, args),
});

export const recordRemoteConflict = mutation({
  args: {
    operationId: v.string(),
    leaseId: v.string(),
    currentRemoteSnapshot: calendarEventSnapshotValidator,
    remoteEtag: v.optional(v.string()),
    remoteUpdatedAt: v.optional(v.number()),
    safeError: v.string(),
  },
  handler: (ctx, args) => recordRemoteConflictHandler(ctx, args),
});

export const recordRemoteRetry = mutation({
  args: {
    operationId: v.string(),
    leaseId: v.string(),
    safeError: v.string(),
    retryAt: v.number(),
  },
  handler: (ctx, args) => recordRemoteRetryHandler(ctx, args),
});

export const recordRemoteFailure = mutation({
  args: {
    operationId: v.string(),
    leaseId: v.string(),
    safeError: v.string(),
  },
  handler: (ctx, args) => recordRemoteFailureHandler(ctx, args),
});

export const applyRemotePage = mutation({
  args: {
    accountId: v.string(),
    calendarId: v.string(),
    providerCalendarId: v.optional(v.string()),
    fullSyncGeneration: v.optional(v.number()),
    events: v.array(
      v.object({
        remoteSnapshot: calendarEventSnapshotValidator,
        remoteEtag: v.optional(v.string()),
        remoteUpdatedAt: v.optional(v.number()),
        deleted: v.optional(v.boolean()),
        recurringEventId: v.optional(v.string()),
      }),
    ),
  },
  handler: (ctx, args) => applyRemotePageHandler(ctx, args),
});

export const completeRemoteSync = mutation({
  args: {
    accountId: v.string(),
    calendarId: v.string(),
    providerCalendarId: v.optional(v.string()),
    syncToken: v.optional(v.string()),
    fullSyncGeneration: v.optional(v.number()),
  },
  handler: (ctx, args) => completeRemoteSyncHandler(ctx, args),
});

export const releaseLease = mutation({
  args: { leaseId: v.string() },
  handler: (ctx, args) => releaseLeaseHandler(ctx, args),
});
