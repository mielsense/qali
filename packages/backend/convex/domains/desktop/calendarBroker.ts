import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireDesktopBroker } from "./identity";
import {
  completeOperationFromRow,
  localEventIdForRemote,
} from "../calendar/model";
import {
  rebaseRemoteSnapshot,
  reducePendingOperations,
  operationConflictGroups,
  type ProjectedCalendarEvent,
} from "../calendar/projection";
import type {
  CalendarEventSnapshot,
  CalendarOperationState,
} from "../calendar/operations";
import {
  activeOperationRowsForEvent,
  MAX_ACTIVE_OPERATION_CHAIN,
  planCalendarOperationUploads,
} from "../calendar/operations";
import {
  googleAccountIdForSubject,
  googleCalendarKey,
} from "../calendar/providerIdentity";

const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_LEASE_LIMIT = 25;
const MAX_REMOTE_PAGE = 250;
const MAX_SAFE_ERROR_BYTES = 512;
const MAX_RECEIPT_BYTES = 2_048;
const LEASE_CANDIDATE_STATES = ["pending", "ambiguous", "syncing"] as const;
const MAX_LEASE_CANDIDATES = 96;
const MAX_LEASE_GROUP_ROWS = MAX_LEASE_LIMIT * MAX_ACTIVE_OPERATION_CHAIN;
const MAX_SYNC_STATE_ROWS = 1_000;
const MAX_CALENDAR_LIST_ROWS = 250;
const MAX_EXPORT_EVENT_ROWS = 4_000;
const MAX_EXPORT_OPERATION_ROWS = 4_000;
const MAX_CANDIDATES_PER_STATE = Math.floor(
  MAX_LEASE_CANDIDATES / LEASE_CANDIDATE_STATES.length,
);

type RemotePageEvent = Readonly<{
  remoteSnapshot: CalendarEventSnapshot;
  remoteEtag?: string;
  remoteUpdatedAt?: number;
  deleted?: boolean;
  recurringEventId?: string;
}>;

function assertOpaque(value: string, label: string, max = 1_024): void {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`${label}_INVALID`);
}

function legacyStatusFor(
  state: CalendarOperationState,
): Doc<"calendarOperations">["status"] {
  if (state === "succeeded" || state === "cancelled") return "succeeded";
  if (state === "ambiguous") return "ambiguous";
  if (state === "failed" || state === "conflict") return "failed";
  return "pending";
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

async function googleConnectionForAccount(
  ctx: MutationCtx | QueryCtx,
  userId: string,
  accountId: string,
): Promise<Doc<"calendarConnections"> | null> {
  return await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_provider_account", (query) =>
      query
        .eq("userId", userId)
        .eq("provider", "google")
        .eq("accountId", accountId),
    )
    .unique();
}

export async function attachGoogleAccount(
  ctx: MutationCtx,
  args: {
    accountId: string;
    providerAccountId: string;
    accountEmail?: string;
  },
): Promise<{
  connectionId: Id<"calendarConnections">;
  claimedLegacy: boolean;
}> {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.accountId, "CALENDAR_ACCOUNT_ID");
  assertOpaque(args.providerAccountId, "GOOGLE_SUBJECT_INVALID");
  if (
    args.accountEmail !== undefined &&
    (args.accountEmail.length > 320 || /[\u0000-\u001f\u007f]/.test(args.accountEmail))
  ) {
    throw new Error("GOOGLE_ACCOUNT_EMAIL_INVALID");
  }
  if ((await googleAccountIdForSubject(args.providerAccountId)) !== args.accountId) {
    throw new Error("GOOGLE_ACCOUNT_ID_MISMATCH");
  }
  const now = Date.now();
  const exact = await googleConnectionForAccount(ctx, user.id, args.accountId);
  if (exact) {
    if (
      exact.providerAccountId !== undefined &&
      exact.providerAccountId !== args.providerAccountId
    ) {
      throw new Error("GOOGLE_ACCOUNT_IDENTITY_CONFLICT");
    }
    await ctx.db.patch(exact._id, {
      providerAccountId: args.providerAccountId,
      accountEmail: args.accountEmail,
      status: "active",
      lastError: undefined,
      updatedAt: now,
    });
    return {
      connectionId: exact._id,
      claimedLegacy: exact.legacyMigrationState === "claimed",
    };
  }
  const bySubject = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_provider_subject", (query) =>
      query
        .eq("userId", user.id)
        .eq("provider", "google")
        .eq("providerAccountId", args.providerAccountId),
    )
    .unique();
  if (bySubject) {
    if (bySubject.accountId !== undefined && bySubject.accountId !== args.accountId) {
      throw new Error("GOOGLE_ACCOUNT_IDENTITY_CONFLICT");
    }
    await ctx.db.patch(bySubject._id, {
      accountId: args.accountId,
      accountEmail: args.accountEmail,
      status: "active",
      lastError: undefined,
      updatedAt: now,
    });
    return {
      connectionId: bySubject._id,
      claimedLegacy: bySubject.legacyMigrationState === "claimed",
    };
  }
  const connections = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_and_provider", (query) =>
      query.eq("userId", user.id).eq("provider", "google"),
    )
    .take(10);
  const unscoped = connections.filter(
    (connection) =>
      connection.accountId === undefined &&
      connection.providerAccountId === undefined,
  );
  if (unscoped.length === 1) {
    await ctx.db.patch(unscoped[0]!._id, {
      accountId: args.accountId,
      providerAccountId: args.providerAccountId,
      accountEmail: args.accountEmail,
      status: "active",
      lastError: undefined,
      legacyMigrationState: "claimed",
      updatedAt: now,
    });
    return { connectionId: unscoped[0]!._id, claimedLegacy: true };
  }
  const connectionId = await ctx.db.insert("calendarConnections", {
    userId: user.id,
    provider: "google",
    accountId: args.accountId,
    providerAccountId: args.providerAccountId,
    accountEmail: args.accountEmail,
    status: "active",
    legacyMigrationState: "complete",
    createdAt: now,
    updatedAt: now,
  });
  return { connectionId, claimedLegacy: false };
}

function projectedEventFields(projection: ProjectedCalendarEvent) {
  return withoutUndefined({
    calendarId: projection.calendarId,
    googleEventId:
      projection.remoteEventId ?? `local-${projection.localEventId}`,
    summary: projection.summary ?? undefined,
    description:
      typeof projection.description === "string"
        ? projection.description
        : undefined,
    location:
      typeof projection.location === "string" ? projection.location : undefined,
    startMs: projection.startMs,
    endMs: projection.endMs,
    allDay: projection.allDay,
    status: projection.status,
    colorId:
      typeof projection.colorId === "string" ? projection.colorId : undefined,
    visibility:
      typeof projection.visibility === "string"
        ? projection.visibility
        : undefined,
    transparency:
      typeof projection.transparency === "string"
        ? projection.transparency
        : undefined,
    attendees: projection.attendees?.map((attendee) => ({ ...attendee })),
    hangoutLink:
      typeof projection.hangoutLink === "string"
        ? projection.hangoutLink
        : undefined,
    conferenceUrl:
      typeof projection.conferenceUrl === "string"
        ? projection.conferenceUrl
        : undefined,
    conferenceName:
      typeof projection.conferenceName === "string"
        ? projection.conferenceName
        : undefined,
    conferenceType:
      typeof projection.conferenceType === "string"
        ? projection.conferenceType
        : undefined,
    syncState: projection.syncState,
  });
}

/** Keep guest suggestions calendar-derived without any People/Contacts feed. */
async function rememberCalendarAttendees(
  ctx: MutationCtx,
  userId: string,
  attendees: CalendarEventSnapshot["attendees"],
): Promise<void> {
  const unique = new Map<string, string | undefined>();
  for (const attendee of attendees ?? []) {
    const email = attendee.email.trim().toLowerCase();
    if (!email || attendee.self) continue;
    unique.set(email, unique.get(email) ?? attendee.displayName);
  }
  const now = Date.now();
  for (const [email, displayName] of unique) {
    const existing = await ctx.db
      .query("people")
      .withIndex("by_user_and_email", (query) =>
        query.eq("userId", userId).eq("email", email),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        displayName: existing.displayName ?? displayName,
        sources: ["attendee"],
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("people", {
        userId,
        email,
        displayName,
        sources: ["attendee"],
        updatedAt: now,
      });
    }
  }
}

async function operationsForEvent(
  ctx: MutationCtx,
  userId: string,
  localEventId: string,
) {
  const rows = await activeOperationRowsForEvent(ctx, userId, localEventId);
  return rows.flatMap((row) => {
    const operation = completeOperationFromRow(row);
    return operation ? [operation] : [];
  });
}

/** Resolve a provider event back to its durable local identity before applying
 * a pull page. Locally-created events deliberately keep their operation-backed
 * identity after Google assigns an id; deriving a fresh remote identity here
 * would render the same logical event twice on the next sync cycle. */
async function localIdentityForRemoteEvent(
  ctx: MutationCtx,
  args: {
    userId: string;
    accountId: string;
    calendarId: string;
    connectionId?: Id<"calendarConnections">;
    remoteEventId: string;
    explicitLocalEventId?: string;
  },
): Promise<string> {
  const derivedLocalEventId = localEventIdForRemote(
    args.calendarId,
    args.remoteEventId,
  );
  const candidates = new Map<string, Doc<"events">>();
  if (args.connectionId !== undefined) {
    const neutralRows = await ctx.db
      .query("events")
      .withIndex("by_connection_and_providerEventId", (query) =>
        query
          .eq("connectionId", args.connectionId)
          .eq("providerEventId", args.remoteEventId),
      )
      .take(4);
    for (const row of neutralRows) candidates.set(String(row._id), row);
  }
  const legacyRows = await ctx.db
    .query("events")
    .withIndex("by_user_and_calendar_and_googleEventId", (query) =>
      query
        .eq("userId", args.userId)
        .eq("calendarId", args.calendarId)
        .eq("googleEventId", args.remoteEventId),
    )
    .take(4);
  for (const row of legacyRows) candidates.set(String(row._id), row);

  const scopedRows = [...candidates.values()].filter(
    (row): row is Doc<"events"> & { localEventId: string } =>
      row.userId === args.userId &&
      row.localEventId !== undefined &&
      row.calendarId === args.calendarId &&
      (row.accountId === undefined || row.accountId === args.accountId),
  );
  const operationBacked: Doc<"events">[] = [];
  for (const row of scopedRows) {
    const firstOperation = await ctx.db
      .query("calendarOperations")
      .withIndex("by_user_and_localEvent_and_createdAt", (query) =>
        query
          .eq("userId", args.userId)
          .eq("localEventId", row.localEventId),
      )
      .order("asc")
      .take(1);
    if (firstOperation.length > 0) operationBacked.push(row);
  }
  if (operationBacked.length > 1) {
    throw new Error("CALENDAR_PROVIDER_IDENTITY_CONFLICT");
  }
  const explicit = args.explicitLocalEventId?.trim();
  const canonical =
    operationBacked[0] ??
    (explicit
      ? scopedRows.find((row) => row.localEventId === explicit)
      : undefined) ??
    scopedRows.find((row) => row.localEventId !== derivedLocalEventId) ??
    scopedRows[0];
  const localEventId =
    canonical?.localEventId || explicit || derivedLocalEventId;

  // Repair rows produced by the old split-identity importer. A duplicate with
  // active local intent is never discarded silently; that is a real conflict.
  for (const row of scopedRows) {
    if (row._id === canonical?._id) continue;
    if ((await activeOperationRowsForEvent(ctx, args.userId, row.localEventId)).length > 0) {
      throw new Error("CALENDAR_PROVIDER_IDENTITY_CONFLICT");
    }
    await ctx.db.delete(row._id);
  }
  return localEventId;
}

async function rebuildProjection(
  ctx: MutationCtx,
  userId: string,
  baseline: CalendarEventSnapshot,
  metadata: {
    remoteEtag?: string;
    remoteUpdatedAt?: number;
    syncGeneration?: number;
    recurringEventId?: string;
  },
): Promise<void> {
  const operationRows = await activeOperationRowsForEvent(
    ctx,
    userId,
    baseline.localEventId,
  );
  const operations = operationRows.flatMap((row) => {
    const operation = completeOperationFromRow(row);
    return operation ? [operation] : [];
  });
  const existing = await ctx.db
    .query("events")
    .withIndex("by_user_and_localEventId", (query) =>
      query.eq("userId", userId).eq("localEventId", baseline.localEventId),
    )
    .unique();
  const previousBaseline = existing?.remoteSnapshot as
    CalendarEventSnapshot | undefined;
  const rebased = previousBaseline
    ? rebaseRemoteSnapshot(previousBaseline, baseline, operations)
    : {
        projection: reducePendingOperations(baseline, operations),
        conflicts: [],
      };
  const projection = rebased.projection;
  const conflictSet = new Set(rebased.conflicts);
  for (const row of operationRows) {
    const operation = completeOperationFromRow(row);
    if (!operation) continue;
    const conflicts = [...operationConflictGroups(operation)].some((group) =>
      conflictSet.has(group),
    );
    if (
      conflicts &&
      ["pending", "syncing", "ambiguous", "failed"].includes(operation.state)
    ) {
      await ctx.db.patch(row._id, {
        state: "conflict",
        status: "failed",
        leaseReady: false,
        leaseId: undefined,
        leaseExpiresAt: undefined,
        leasePreviousState: undefined,
        safeError: "remote_conflict",
        lastError: "remote_conflict",
        updatedAt: Date.now(),
      });
      continue;
    }
    if (
      metadata.remoteEtag !== undefined &&
      row.baseRemoteSnapshot !== undefined &&
      ["pending", "ambiguous", "failed"].includes(operation.state)
    ) {
      await ctx.db.patch(row._id, {
        uploadBaseRemoteSnapshot: baseline,
        uploadBaseRemoteEtag: metadata.remoteEtag,
        updatedAt: Date.now(),
      });
    }
  }
  if (projection === null) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  const scopedCalendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (query) =>
      query
        .eq("userId", userId)
        .eq("googleCalendarId", projection.calendarId),
    )
    .unique();
  if (
    scopedCalendar !== null &&
    scopedCalendar.accountId !== undefined &&
    scopedCalendar.accountId !== baseline.accountId
  ) {
    throw new Error("CALENDAR_REMOTE_SCOPE_MISMATCH");
  }
  const value = {
    userId,
    localEventId: baseline.localEventId,
    accountId: baseline.accountId,
    ...projectedEventFields(projection),
    googleUpdatedMs: metadata.remoteUpdatedAt ?? existing?.googleUpdatedMs ?? 0,
    providerUpdatedMs: metadata.remoteUpdatedAt ?? existing?.providerUpdatedMs,
    providerEventId: baseline.remoteEventId,
    connectionId: scopedCalendar?.connectionId ?? existing?.connectionId,
    remoteSnapshot: baseline,
    remoteEtag: metadata.remoteEtag,
    remoteUpdatedAt: metadata.remoteUpdatedAt,
    syncGeneration: metadata.syncGeneration ?? existing?.syncGeneration,
    recurringEventId: metadata.recurringEventId ?? existing?.recurringEventId,
  };
  await rememberCalendarAttendees(ctx, userId, projection.attendees);
  if (existing) await ctx.db.replace(existing._id, withoutUndefined(value));
  else await ctx.db.insert("events", withoutUndefined(value));
}

async function operationById(
  ctx: MutationCtx,
  userId: string,
  operationId: string,
): Promise<Doc<"calendarOperations">> {
  assertOpaque(operationId, "CALENDAR_OPERATION_ID", 128);
  const operation = await ctx.db
    .query("calendarOperations")
    .withIndex("by_user_and_operationId", (query) =>
      query.eq("userId", userId).eq("operationId", operationId),
    )
    .unique();
  if (!operation) throw new Error("CALENDAR_OPERATION_NOT_FOUND");
  return operation;
}

function assertLease(
  operation: Doc<"calendarOperations">,
  leaseId: string,
): void {
  assertOpaque(leaseId, "CALENDAR_LEASE_ID", 128);
  if (
    operation.state !== "syncing" ||
    operation.leaseId !== leaseId ||
    operation.leaseExpiresAt === undefined ||
    operation.leaseExpiresAt < Date.now()
  )
    throw new Error("CALENDAR_OPERATION_LEASE_MISMATCH");
}

async function demoteLeaseCandidate(
  ctx: MutationCtx,
  candidate: Doc<"calendarOperations">,
  now: number,
): Promise<void> {
  await ctx.db.patch(candidate._id, {
    leaseReady: false,
    nextLeaseAt: 0,
    updatedAt: now,
  });
}

async function leasedOperationGroup(
  ctx: MutationCtx,
  userId: string,
  leader: Doc<"calendarOperations">,
  leaseId: string,
): Promise<Doc<"calendarOperations">[]> {
  assertLease(leader, leaseId);
  const leaderOperationId = leader.operationId;
  if (!leaderOperationId) throw new Error("CALENDAR_OPERATION_NOT_FOUND");
  const rows = await ctx.db
    .query("calendarOperations")
    .withIndex("by_user_and_leaseLeaderOperationId", (query) =>
      query
        .eq("userId", userId)
        .eq("leaseLeaderOperationId", leaderOperationId),
    )
    .take(MAX_ACTIVE_OPERATION_CHAIN + 1);
  if (rows.length > MAX_ACTIVE_OPERATION_CHAIN) {
    throw new Error("CALENDAR_ACTIVE_CHAIN_TOO_LARGE");
  }
  const group = rows.filter(
    (row) => row.state === "syncing" && row.leaseId === leaseId,
  );
  return group.length > 0 ? group : [leader];
}

async function unlockSuccessors(
  ctx: MutationCtx,
  userId: string,
  completedOperationIds: readonly string[],
): Promise<void> {
  for (const operationId of completedOperationIds) {
    const successors = await ctx.db
      .query("calendarOperations")
      .withIndex("by_user_and_predecessorOperationId", (query) =>
        query.eq("userId", userId).eq("predecessorOperationId", operationId),
      )
      .take(MAX_ACTIVE_OPERATION_CHAIN + 1);
    if (successors.length > MAX_ACTIVE_OPERATION_CHAIN) {
      throw new Error("CALENDAR_ACTIVE_CHAIN_TOO_LARGE");
    }
    for (const successor of successors) {
      if (successor.state === "pending") {
        await ctx.db.patch(successor._id, {
          leaseReady: true,
          updatedAt: Date.now(),
        });
      }
    }
  }
}

function assertRemoteSnapshotScope(
  operation: Doc<"calendarOperations">,
  snapshot: CalendarEventSnapshot,
  expectedCalendarId: string | undefined,
): void {
  if (
    snapshot.accountId !== operation.accountId ||
    snapshot.localEventId !== operation.localEventId ||
    snapshot.calendarId !== expectedCalendarId ||
    (operation.kind !== "create" &&
      operation.remoteEventId !== undefined &&
      snapshot.remoteEventId !== operation.remoteEventId)
  )
    throw new Error("CALENDAR_REMOTE_SCOPE_MISMATCH");
}

export async function leaseOperations(
  ctx: MutationCtx,
  args: {
    accountId: string;
    leaseId: string;
    limit?: number;
    leaseDurationMs?: number;
  },
) {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.accountId, "CALENDAR_ACCOUNT_ID");
  assertOpaque(args.leaseId, "CALENDAR_LEASE_ID", 128);
  const limit = args.limit ?? 10;
  const leaseDurationMs = args.leaseDurationMs ?? 30_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEASE_LIMIT) {
    throw new Error("CALENDAR_LEASE_LIMIT_INVALID");
  }
  if (
    !Number.isInteger(leaseDurationMs) ||
    leaseDurationMs < MIN_LEASE_MS ||
    leaseDurationMs > MAX_LEASE_MS
  )
    throw new Error("CALENDAR_LEASE_DURATION_INVALID");

  const now = Date.now();
  const candidates: Doc<"calendarOperations">[] = [];
  // Each state gets a deterministic lane within one shared transaction budget.
  // Stale rows are demoted in bounded batches, while no busy state can prevent
  // another state from contributing a full normal lease batch.
  for (const state of LEASE_CANDIDATE_STATES) {
    const page = await ctx.db
      .query("calendarOperations")
      .withIndex("by_user_account_state_ready_due_created", (query) =>
        query
          .eq("userId", user.id)
          .eq("accountId", args.accountId)
          .eq("state", state)
          .eq("leaseReady", true)
          .lte("nextLeaseAt", now),
      )
      .take(MAX_CANDIDATES_PER_STATE);
    candidates.push(...page);
  }
  candidates.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      (left.operationId ?? left.idempotencyKey).localeCompare(
        right.operationId ?? right.idempotencyKey,
      ),
  );

  const leased = [];
  const claimedEvents = new Set<string>();
  for (const candidate of candidates) {
    if (leased.length >= limit) break;
    if (candidate.userId !== user.id) continue;
    if (
      !candidate.operationId ||
      !candidate.localEventId ||
      !candidate.state ||
      !candidate.payload
    ) {
      await demoteLeaseCandidate(ctx, candidate, now);
      continue;
    }
    if (claimedEvents.has(candidate.localEventId)) continue;
    if (candidate.predecessorOperationId) {
      const predecessor = await ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (query) =>
          query
            .eq("userId", user.id)
            .eq("operationId", candidate.predecessorOperationId),
        )
        .unique();
      if (
        !predecessor ||
        (predecessor.state !== "succeeded" && predecessor.state !== "cancelled")
      ) {
        await demoteLeaseCandidate(ctx, candidate, now);
        continue;
      }
    }
    const operationRows = await activeOperationRowsForEvent(
      ctx,
      user.id,
      candidate.localEventId,
    );
    const operations = operationRows.flatMap((row) => {
      const operation = completeOperationFromRow(row);
      return operation ? [operation] : [];
    });
    const plan = planCalendarOperationUploads(operations);
    if (plan.cancelledOperationIds.includes(candidate.operationId)) {
      const cancelled = new Set(plan.cancelledOperationIds);
      for (const row of operationRows) {
        if (!row.operationId || !cancelled.has(row.operationId)) continue;
        await ctx.db.patch(row._id, {
          state: "cancelled",
          status: "succeeded",
          leaseReady: false,
          nextLeaseAt: 0,
          updatedAt: now,
        });
      }
      await unlockSuccessors(ctx, user.id, plan.cancelledOperationIds);
      continue;
    }
    const upload = plan.uploads.find(
      (entry) => entry.operation.operationId === candidate.operationId,
    );
    if (!upload) {
      await demoteLeaseCandidate(ctx, candidate, now);
      continue;
    }
    const groupIds = new Set(upload.consumedOperationIds);
    const leaseExpiresAt = now + leaseDurationMs;
    for (const row of operationRows) {
      if (!row.operationId || !groupIds.has(row.operationId)) continue;
      const leasedFromState =
        row.state === "syncing" ? "ambiguous" : (row.state ?? "pending");
      await ctx.db.patch(row._id, {
        state: "syncing",
        status: "pending",
        attemptCount: (row.attemptCount ?? 0) + 1,
        leaseId: args.leaseId,
        leaseExpiresAt,
        leasePreviousState: leasedFromState,
        leaseLeaderOperationId: candidate.operationId,
        leaseReady: row.operationId === candidate.operationId,
        nextLeaseAt: leaseExpiresAt,
        retryAt: undefined,
        updatedAt: now,
      });
    }
    claimedEvents.add(candidate.localEventId);
    const leasedFromState =
      candidate.state === "syncing" ? "ambiguous" : candidate.state;
    const projectedEvent = await ctx.db
      .query("events")
      .withIndex("by_user_and_localEventId", (query) =>
        query.eq("userId", user.id).eq("localEventId", candidate.localEventId),
      )
      .unique();
    leased.push({
      ...candidate,
      ...upload.operation,
      state: "syncing" as const,
      status: "pending" as const,
      attemptCount: (candidate.attemptCount ?? 0) + 1,
      leaseId: args.leaseId,
      leaseExpiresAt,
      leasePreviousState: leasedFromState,
      leaseLeaderOperationId: candidate.operationId,
      leaseReady: true,
      nextLeaseAt: leaseExpiresAt,
      retryAt: undefined,
      updatedAt: now,
      leasedFromState,
      consumedOperationIds: [...upload.consumedOperationIds],
      uploadBaseRemoteSnapshot:
        candidate.uploadBaseRemoteSnapshot ?? candidate.baseRemoteSnapshot,
      uploadBaseRemoteEtag:
        candidate.uploadBaseRemoteEtag ?? candidate.baseRemoteEtag,
      ...(projectedEvent?.recurringEventId
        ? {
            recurrence: {
              recurringEventId: projectedEvent.recurringEventId,
              occurrenceStartMs: projectedEvent.startMs,
            },
          }
        : {}),
    });
  }
  return leased;
}

export async function recordRemoteSuccess(
  ctx: MutationCtx,
  args: {
    operationId: string;
    leaseId: string;
    remoteSnapshot?: CalendarEventSnapshot;
    remoteEtag?: string;
    remoteUpdatedAt?: number;
    remoteReceipt?: string;
  },
): Promise<null> {
  const user = await requireDesktopBroker(ctx);
  const operation = await operationById(ctx, user.id, args.operationId);
  assertLease(operation, args.leaseId);
  if (operation.kind !== "delete" && args.remoteSnapshot === undefined) {
    throw new Error("CALENDAR_REMOTE_SNAPSHOT_REQUIRED");
  }
  if (args.remoteSnapshot) {
    const expectedCalendarId =
      operation.kind === "move" &&
      operation.payload &&
      "destinationCalendarId" in operation.payload
        ? operation.payload.destinationCalendarId
        : operation.calendarId;
    assertRemoteSnapshotScope(
      operation,
      args.remoteSnapshot,
      expectedCalendarId,
    );
  }
  if (args.remoteReceipt !== undefined) {
    assertOpaque(
      args.remoteReceipt,
      "CALENDAR_REMOTE_RECEIPT",
      MAX_RECEIPT_BYTES,
    );
  }
  const now = Date.now();
  const group = await leasedOperationGroup(
    ctx,
    user.id,
    operation,
    args.leaseId,
  );
  for (const row of group) {
    await ctx.db.patch(row._id, {
      state: "succeeded",
      status: "succeeded",
      leaseReady: false,
      nextLeaseAt: 0,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      leasePreviousState: undefined,
      leaseLeaderOperationId: undefined,
      retryAt: undefined,
      safeError: undefined,
      lastError: undefined,
      remoteReceipt: args.remoteReceipt,
      remoteEventId: args.remoteSnapshot?.remoteEventId ?? row.remoteEventId,
      providerEventId:
        args.remoteSnapshot?.remoteEventId ?? row.providerEventId,
      updatedAt: now,
    });
  }
  await unlockSuccessors(
    ctx,
    user.id,
    group.flatMap((row) => (row.operationId ? [row.operationId] : [])),
  );
  if (operation.kind === "delete" && operation.localEventId) {
    const event = await ctx.db
      .query("events")
      .withIndex("by_user_and_localEventId", (query) =>
        query.eq("userId", user.id).eq("localEventId", operation.localEventId),
      )
      .unique();
    if (event) await ctx.db.delete(event._id);
    return null;
  }
  const baseline = args.remoteSnapshot ?? operation.baseRemoteSnapshot;
  if (baseline) {
    await rebuildProjection(ctx, user.id, baseline as CalendarEventSnapshot, {
      remoteEtag: args.remoteEtag,
      remoteUpdatedAt: args.remoteUpdatedAt,
    });
  }
  return null;
}

export async function recordRemoteAmbiguous(
  ctx: MutationCtx,
  args: {
    operationId: string;
    leaseId: string;
    safeError: string;
    retryAt?: number;
  },
): Promise<null> {
  const user = await requireDesktopBroker(ctx);
  const operation = await operationById(ctx, user.id, args.operationId);
  assertLease(operation, args.leaseId);
  assertOpaque(args.safeError, "CALENDAR_SAFE_ERROR", MAX_SAFE_ERROR_BYTES);
  if (
    args.retryAt !== undefined &&
    (!Number.isFinite(args.retryAt) || args.retryAt < Date.now())
  ) {
    throw new Error("CALENDAR_RETRY_AT_INVALID");
  }
  const group = await leasedOperationGroup(
    ctx,
    user.id,
    operation,
    args.leaseId,
  );
  const now = Date.now();
  for (const row of group) {
    await ctx.db.patch(row._id, {
      state: "ambiguous",
      status: "ambiguous",
      leaseReady: row.operationId === operation.operationId,
      nextLeaseAt: args.retryAt ?? now,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      leasePreviousState: undefined,
      safeError: args.safeError,
      lastError: args.safeError,
      retryAt: args.retryAt,
      updatedAt: now,
    });
  }
  return null;
}

export async function recordRemoteConflict(
  ctx: MutationCtx,
  args: {
    operationId: string;
    leaseId: string;
    currentRemoteSnapshot: CalendarEventSnapshot;
    remoteEtag?: string;
    remoteUpdatedAt?: number;
    safeError: string;
  },
): Promise<null> {
  const user = await requireDesktopBroker(ctx);
  const operation = await operationById(ctx, user.id, args.operationId);
  assertLease(operation, args.leaseId);
  assertOpaque(args.safeError, "CALENDAR_SAFE_ERROR", MAX_SAFE_ERROR_BYTES);
  assertRemoteSnapshotScope(
    operation,
    args.currentRemoteSnapshot,
    operation.calendarId,
  );
  const group = await leasedOperationGroup(
    ctx,
    user.id,
    operation,
    args.leaseId,
  );
  const now = Date.now();
  for (const row of group) {
    await ctx.db.patch(row._id, {
      state: "conflict",
      status: "failed",
      leaseReady: false,
      nextLeaseAt: 0,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      leasePreviousState: undefined,
      leaseLeaderOperationId: undefined,
      safeError: args.safeError,
      lastError: args.safeError,
      updatedAt: now,
    });
  }
  const base = operation.baseRemoteSnapshot as
    CalendarEventSnapshot | undefined;
  if (base) {
    const operations = await operationsForEvent(
      ctx,
      user.id,
      args.currentRemoteSnapshot.localEventId,
    );
    const result = rebaseRemoteSnapshot(
      base,
      args.currentRemoteSnapshot,
      operations,
    );
    const existing = await ctx.db
      .query("events")
      .withIndex("by_user_and_localEventId", (query) =>
        query
          .eq("userId", user.id)
          .eq("localEventId", args.currentRemoteSnapshot.localEventId),
      )
      .unique();
    if (result.projection) {
      const replacement = withoutUndefined({
        userId: user.id,
        localEventId: args.currentRemoteSnapshot.localEventId,
        accountId: args.currentRemoteSnapshot.accountId,
        ...projectedEventFields(result.projection),
        googleUpdatedMs: args.remoteUpdatedAt ?? existing?.googleUpdatedMs ?? 0,
        providerUpdatedMs: args.remoteUpdatedAt,
        providerEventId: args.currentRemoteSnapshot.remoteEventId,
        connectionId: existing?.connectionId,
        remoteSnapshot: args.currentRemoteSnapshot,
        remoteEtag: args.remoteEtag,
        remoteUpdatedAt: args.remoteUpdatedAt,
      });
      if (existing) await ctx.db.replace(existing._id, replacement);
      else await ctx.db.insert("events", replacement);
    }
  }
  return null;
}

export async function applyRemotePage(
  ctx: MutationCtx,
  args: {
    accountId: string;
    calendarId: string;
    providerCalendarId?: string;
    events: readonly RemotePageEvent[];
    fullSyncGeneration?: number;
  },
): Promise<{ applied: number }> {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.accountId, "CALENDAR_ACCOUNT_ID");
  assertOpaque(args.calendarId, "CALENDAR_ID");
  if (args.accountId.startsWith("gacc_") && args.providerCalendarId === undefined) {
    throw new Error("GOOGLE_PROVIDER_CALENDAR_ID_REQUIRED");
  }
  const scopedCalendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (query) =>
      query.eq("userId", user.id).eq("googleCalendarId", args.calendarId),
    )
    .unique();
  if (args.providerCalendarId !== undefined) {
    assertOpaque(args.providerCalendarId, "GOOGLE_CALENDAR_ID_INVALID");
    if (
      !scopedCalendar ||
      scopedCalendar.accountId !== args.accountId ||
      scopedCalendar.providerCalendarId !== args.providerCalendarId
    ) {
      throw new Error("CALENDAR_REMOTE_SCOPE_MISMATCH");
    }
  }
  if (args.events.length > MAX_REMOTE_PAGE)
    throw new Error("CALENDAR_REMOTE_PAGE_TOO_LARGE");
  if (args.fullSyncGeneration !== undefined) {
    if (
      !Number.isSafeInteger(args.fullSyncGeneration) ||
      args.fullSyncGeneration < 1
    ) {
      throw new Error("CALENDAR_SYNC_GENERATION_INVALID");
    }
    if (
      !scopedCalendar ||
      scopedCalendar.accountId !== args.accountId ||
      scopedCalendar.syncGeneration !== args.fullSyncGeneration
    ) {
      throw new Error("CALENDAR_FULL_SYNC_MISMATCH");
    }
  }
  for (const incoming of args.events) {
    if (
      incoming.remoteSnapshot.accountId !== args.accountId ||
      incoming.remoteSnapshot.calendarId !== args.calendarId
    )
      throw new Error("CALENDAR_REMOTE_SCOPE_MISMATCH");
    if (incoming.recurringEventId !== undefined) {
      assertOpaque(incoming.recurringEventId, "CALENDAR_RECURRING_EVENT_ID");
    }
    const remoteEventId = incoming.remoteSnapshot.remoteEventId;
    if (remoteEventId === undefined) {
      throw new Error("CALENDAR_REMOTE_EVENT_ID_REQUIRED");
    }
    assertOpaque(remoteEventId, "CALENDAR_REMOTE_EVENT_ID");
    const localEventId = await localIdentityForRemoteEvent(ctx, {
      userId: user.id,
      accountId: args.accountId,
      calendarId: args.calendarId,
      connectionId: scopedCalendar?.connectionId,
      remoteEventId,
      explicitLocalEventId: incoming.remoteSnapshot.localEventId,
    });
    const baseline = {
      ...incoming.remoteSnapshot,
      localEventId,
      ...(args.providerCalendarId === undefined
        ? {}
        : { providerCalendarId: args.providerCalendarId }),
    };
    if (incoming.deleted) {
      const operationRows = await activeOperationRowsForEvent(
        ctx,
        user.id,
        localEventId,
      );
      const operations = operationRows.flatMap((row) => {
        const operation = completeOperationFromRow(row);
        return operation ? [operation] : [];
      });
      const existing = await ctx.db
        .query("events")
        .withIndex("by_user_and_localEventId", (query) =>
          query.eq("userId", user.id).eq("localEventId", localEventId),
        )
        .unique();
      const active = operations.filter((operation) =>
        ["pending", "syncing", "ambiguous", "failed", "conflict"].includes(
          operation.state,
        ),
      );
      if (active.length > 0) {
        for (const row of operationRows) {
          if (
            !row.state ||
            !active.some((entry) => entry.operationId === row.operationId)
          )
            continue;
          await ctx.db.patch(row._id, {
            state: "conflict",
            status: "failed",
            leaseReady: false,
            nextLeaseAt: 0,
            leaseId: undefined,
            leaseExpiresAt: undefined,
            leasePreviousState: undefined,
            safeError: "remote_deleted",
            lastError: "remote_deleted",
            updatedAt: Date.now(),
          });
        }
        if (existing)
          await ctx.db.patch(existing._id, { syncState: "conflict" });
      } else if (existing) {
        await ctx.db.delete(existing._id);
      }
      continue;
    }
    await rebuildProjection(ctx, user.id, baseline, {
      ...incoming,
      ...(args.fullSyncGeneration === undefined
        ? {}
        : { syncGeneration: args.fullSyncGeneration }),
      ...(incoming.recurringEventId === undefined
        ? {}
        : { recurringEventId: incoming.recurringEventId }),
    });
  }
  return { applied: args.events.length };
}

export async function completeRemoteSync(
  ctx: MutationCtx,
  args: {
    accountId: string;
    calendarId: string;
    providerCalendarId?: string;
    syncToken?: string;
    fullSyncGeneration?: number;
  },
): Promise<{ done: boolean; removed: number }> {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.accountId, "CALENDAR_ACCOUNT_ID");
  assertOpaque(args.calendarId, "CALENDAR_ID");
  if (args.accountId.startsWith("gacc_") && args.providerCalendarId === undefined) {
    throw new Error("GOOGLE_PROVIDER_CALENDAR_ID_REQUIRED");
  }
  if (args.providerCalendarId !== undefined) {
    assertOpaque(args.providerCalendarId, "GOOGLE_CALENDAR_ID_INVALID");
  }
  if (args.syncToken !== undefined)
    assertOpaque(args.syncToken, "CALENDAR_SYNC_TOKEN", 8_192);
  const existing = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (query) =>
      query.eq("userId", user.id).eq("googleCalendarId", args.calendarId),
    )
    .unique();
  if (
    args.providerCalendarId !== undefined &&
    (!existing ||
      existing.accountId !== args.accountId ||
      existing.providerCalendarId !== args.providerCalendarId)
  ) {
    throw new Error("CALENDAR_REMOTE_SCOPE_MISMATCH");
  }
  if (args.fullSyncGeneration !== undefined) {
    if (
      !existing ||
      existing.accountId !== args.accountId ||
      existing.syncGeneration !== args.fullSyncGeneration
    ) {
      throw new Error("CALENDAR_FULL_SYNC_MISMATCH");
    }
    const stale = await ctx.db
      .query("events")
      .withIndex("by_user_calendar_generation", (query) =>
        query
          .eq("userId", user.id)
          .eq("calendarId", args.calendarId)
          .lt("syncGeneration", args.fullSyncGeneration!),
      )
      .take(MAX_REMOTE_PAGE);
    for (const event of stale) {
      // A local-only optimistic create has no remote baseline to go missing
      // from this provider snapshot. Stamp it into the generation so paged
      // cleanup can finish, then let the upload phase publish it normally.
      if (event.remoteSnapshot === undefined) {
        await ctx.db.patch(event._id, {
          syncGeneration: args.fullSyncGeneration,
        });
        continue;
      }
      const operations = await activeOperationRowsForEvent(
        ctx,
        user.id,
        event.localEventId ??
          localEventIdForRemote(event.calendarId, event.googleEventId),
      );
      if (operations.length === 0) {
        await ctx.db.delete(event._id);
        continue;
      }
      for (const operation of operations) {
        if (
          !["pending", "syncing", "ambiguous", "failed"].includes(
            operation.state ?? "",
          )
        )
          continue;
        await ctx.db.patch(operation._id, {
          state: "conflict",
          status: "failed",
          leaseReady: false,
          nextLeaseAt: 0,
          leaseId: undefined,
          leaseExpiresAt: undefined,
          leasePreviousState: undefined,
          safeError: "remote_missing_after_full_sync",
          lastError: "remote_missing_after_full_sync",
          updatedAt: Date.now(),
        });
      }
      await ctx.db.patch(event._id, { syncState: "conflict" });
    }
    if (stale.length > 0) return { done: false, removed: stale.length };
  }
  const value = {
    accountId: args.accountId,
    syncToken: args.syncToken,
    syncCursor: args.syncToken,
    lastSyncAt: Date.now(),
  };
  if (existing) await ctx.db.patch(existing._id, value);
  else {
    await ctx.db.insert("calendars", {
      userId: user.id,
      googleCalendarId: args.calendarId,
      providerCalendarId: args.providerCalendarId ?? args.calendarId,
      selected: true,
      ...value,
    });
  }
  return { done: true, removed: 0 };
}

export async function syncState(ctx: QueryCtx, args: { accountId: string }) {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.accountId, "CALENDAR_ACCOUNT_ID");
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (query) => query.eq("userId", user.id))
    .take(MAX_CALENDAR_LIST_ROWS + 1);
  if (calendars.length > MAX_CALENDAR_LIST_ROWS) {
    throw new Error("CALENDAR_LIST_TOO_LARGE");
  }
  const active: Doc<"calendarOperations">[] = [];
  for (const state of LEASE_CANDIDATE_STATES) {
    const rows = await ctx.db
      .query("calendarOperations")
      .withIndex("by_user_and_state_and_createdAt", (query) =>
        query.eq("userId", user.id).eq("state", state),
      )
      .take(MAX_SYNC_STATE_ROWS + 1);
    active.push(...rows.filter((row) => row.accountId === args.accountId));
    if (active.length > MAX_SYNC_STATE_ROWS) {
      throw new Error("CALENDAR_ACTIVE_QUEUE_TOO_LARGE");
    }
  }
  return {
    calendars: calendars
      .filter((calendar) => calendar.accountId === args.accountId)
      .map((calendar) => ({
        accountId: args.accountId,
        calendarId: calendar.calendarKey ?? calendar.googleCalendarId,
        providerCalendarId:
          calendar.providerCalendarId ?? calendar.googleCalendarId,
        syncToken: calendar.syncToken,
      })),
    pendingCount: active.length,
    nextRetryAt: active.reduce<number | undefined>((earliest, row) => {
      const due = row.retryAt ?? row.nextLeaseAt;
      if (due === undefined || due <= Date.now()) return earliest;
      return earliest === undefined ? due : Math.min(earliest, due);
    }, undefined),
  };
}

/** Bounded calendar/application snapshot for an explicit native export. */
export async function exportLocalSnapshot(ctx: QueryCtx) {
  const user = await requireDesktopBroker(ctx);
  const calendars = await ctx.db
    .query("calendars")
    .withIndex("by_user", (query) => query.eq("userId", user.id))
    .take(MAX_CALENDAR_LIST_ROWS + 1);
  const events = await ctx.db
    .query("events")
    .withIndex("by_user_and_start", (query) => query.eq("userId", user.id))
    .take(MAX_EXPORT_EVENT_ROWS + 1);
  if (
    calendars.length > MAX_CALENDAR_LIST_ROWS ||
    events.length > MAX_EXPORT_EVENT_ROWS
  ) {
    throw new Error("CALENDAR_EXPORT_TOO_LARGE");
  }
  const operations: Doc<"calendarOperations">[] = [];
  for (const state of [
    "pending",
    "syncing",
    "ambiguous",
    "failed",
    "conflict",
  ] as const) {
    operations.push(
      ...(await ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_state_and_createdAt", (query) =>
          query.eq("userId", user.id).eq("state", state),
        )
        .take(MAX_EXPORT_OPERATION_ROWS + 1)),
    );
    if (operations.length > MAX_EXPORT_OPERATION_ROWS) {
      throw new Error("CALENDAR_EXPORT_TOO_LARGE");
    }
  }
  return {
    calendars: calendars.map((calendar) => ({
      id: calendar.googleCalendarId,
      name: calendar.summaryOverride ?? calendar.summary,
      color: calendar.backgroundColor,
      timeZone: calendar.timeZone,
      selected: calendar.selected,
    })),
    events: events.map((event) => ({
      id: event.localEventId ?? String(event._id),
      calendarId: event.calendarId,
      title: event.summary,
      description: event.description,
      location: event.location,
      startMs: event.startMs,
      endMs: event.endMs,
      allDay: event.allDay,
      recurrence: event.remoteSnapshot?.recurrence,
      attendees: event.attendees?.map((attendee) => ({
        email: attendee.email,
        displayName: attendee.displayName,
        responseStatus: attendee.responseStatus,
      })),
    })),
    pendingOperations: operations.map((operation) => ({
      id: operation.operationId ?? operation.idempotencyKey,
      kind: operation.kind,
      state:
        operation.state === "syncing"
          ? "in-flight"
          : operation.state === "conflict" || operation.state === "ambiguous"
            ? "ambiguous"
            : (operation.state ?? "pending"),
    })),
  };
}

const LEGACY_CLEANUP_STAGES = [
  "syncState",
  "connectionSyncState",
  "contacts",
  "people",
  "calendarConnections",
] as const;
type LegacyCleanupStage = (typeof LEGACY_CLEANUP_STAGES)[number];
type LegacyRow = Readonly<Record<string, unknown> & { _id: unknown }>;
type LegacyWriter = Readonly<{
  query(table: LegacyCleanupStage): Readonly<{
    paginate(
      options: Readonly<{ cursor: string | null; numItems: number }>,
    ): Promise<
      Readonly<{
        continueCursor: string;
        isDone: boolean;
        page: LegacyRow[];
      }>
    >;
  }>;
  delete(id: unknown): Promise<void>;
  patch(id: unknown, value: Record<string, unknown>): Promise<void>;
}>;

function parseLegacyCleanupCursor(value?: string): {
  stage: LegacyCleanupStage;
  cursor: string | null;
} {
  if (value === undefined)
    return { stage: LEGACY_CLEANUP_STAGES[0], cursor: null };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    const [stage, cursor] = parsed;
    if (
      typeof stage !== "string" ||
      !LEGACY_CLEANUP_STAGES.includes(stage as LegacyCleanupStage) ||
      (cursor !== null && typeof cursor !== "string")
    )
      throw new Error();
    return { stage: stage as LegacyCleanupStage, cursor };
  } catch {
    throw new Error("MIGRATION_CURSOR_INVALID");
  }
}

function encodeLegacyCleanupCursor(
  stage: LegacyCleanupStage,
  cursor: string | null,
): string {
  return JSON.stringify([stage, cursor]);
}

/**
 * Migration-only cleanup run while the additive compatibility schema is
 * deployed. Once this reports done, deploying the contract schema is safe.
 */
export async function cleanupLegacyProviderReferences(
  ctx: MutationCtx,
  args: { cursor?: string },
): Promise<{ done: boolean; cursor?: string; cleared: number }> {
  await requireDesktopBroker(ctx);
  const position = parseLegacyCleanupCursor(args.cursor);
  const writer = ctx.db as unknown as LegacyWriter;
  const page = await writer.query(position.stage).paginate({
    cursor: position.cursor,
    numItems: 25,
  });
  let cleared = 0;
  for (const row of page.page) {
    if (position.stage === "people") {
      const sources = Array.isArray(row.sources) ? row.sources : [];
      if (sources.includes("attendee")) {
        await writer.patch(row._id, {
          sources: ["attendee"],
          photoUrl: undefined,
          otherSyncGeneration: undefined,
        });
      } else {
        await writer.delete(row._id);
      }
      cleared += 1;
      continue;
    }
    if (position.stage === "calendarConnections") {
      if (row.provider !== "google") {
        await writer.delete(row._id);
      } else if (
        row.credentialRef !== undefined ||
        row.capabilities !== undefined
      ) {
        await writer.patch(row._id, {
          credentialRef: undefined,
          capabilities: undefined,
        });
      } else {
        continue;
      }
      cleared += 1;
      continue;
    }
    await writer.delete(row._id);
    cleared += 1;
  }
  if (!page.isDone) {
    return {
      done: false,
      cursor: encodeLegacyCleanupCursor(position.stage, page.continueCursor),
      cleared,
    };
  }
  const stageIndex = LEGACY_CLEANUP_STAGES.indexOf(position.stage);
  const nextStage = LEGACY_CLEANUP_STAGES[stageIndex + 1];
  return {
    done: nextStage === undefined,
    ...(nextStage === undefined
      ? {}
      : { cursor: encodeLegacyCleanupCursor(nextStage, null) }),
    cleared,
  };
}

export async function applyRemoteCalendars(
  ctx: MutationCtx,
  args: {
    accountId: string;
    calendars: readonly Readonly<{
      id: string;
      summary?: string;
      summaryOverride?: string;
      backgroundColor?: string;
      foregroundColor?: string;
      primary?: boolean;
      accessRole?: string;
      timeZone?: string;
      selected?: boolean;
      hidden?: boolean;
      writable: boolean;
    }>[];
  },
): Promise<{ applied: number }> {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.accountId, "CALENDAR_ACCOUNT_ID");
  if (args.calendars.length > MAX_CALENDAR_LIST_ROWS) {
    throw new Error("CALENDAR_LIST_TOO_LARGE");
  }
  const stableAccount = args.accountId.startsWith("gacc_");
  const connection = stableAccount
    ? await googleConnectionForAccount(ctx, user.id, args.accountId)
    : null;
  if (
    stableAccount &&
    (!connection ||
      connection.status !== "active" ||
      connection.providerAccountId === undefined)
  ) {
    throw new Error("GOOGLE_ACCOUNT_NOT_ATTACHED");
  }
  const accessibleIds = new Set<string>();
  for (const incoming of args.calendars) {
    assertOpaque(incoming.id, "CALENDAR_ID");
    accessibleIds.add(incoming.id);
    const calendarKey = stableAccount
      ? await googleCalendarKey(args.accountId, incoming.id)
      : incoming.id;
    const existing = connection
      ? await ctx.db
          .query("calendars")
          .withIndex("by_connection_and_providerCalendarId", (query) =>
            query
              .eq("connectionId", connection._id)
              .eq("providerCalendarId", incoming.id),
          )
          .unique()
      : await ctx.db
          .query("calendars")
          .withIndex("by_user_and_googleCalendarId", (query) =>
            query
              .eq("userId", user.id)
              .eq("googleCalendarId", incoming.id),
          )
          .unique();
    const fields = withoutUndefined({
      accountId: args.accountId,
      connectionId: connection?._id,
      calendarKey: stableAccount ? calendarKey : undefined,
      googleCalendarId: calendarKey,
      providerCalendarId: incoming.id,
      summary: incoming.summary,
      summaryOverride: incoming.summaryOverride,
      backgroundColor: incoming.backgroundColor,
      foregroundColor: incoming.foregroundColor,
      primary: incoming.primary,
      accessRole:
        incoming.accessRole ?? (incoming.writable ? "writer" : "reader"),
      timeZone: incoming.timeZone,
      googleSelected: incoming.selected,
    });
    if (existing) await ctx.db.patch(existing._id, fields);
    else {
      await ctx.db.insert("calendars", {
        userId: user.id,
        selected: incoming.selected ?? incoming.primary ?? true,
        ...fields,
      });
    }
  }
  const known = await ctx.db
    .query("calendars")
    .withIndex("by_user", (query) => query.eq("userId", user.id))
    .take(MAX_CALENDAR_LIST_ROWS + 1);
  if (known.length > MAX_CALENDAR_LIST_ROWS) {
    throw new Error("CALENDAR_LIST_TOO_LARGE");
  }
  for (const calendar of known) {
    if (
      calendar.accountId !== args.accountId ||
      (connection !== null && calendar.connectionId !== connection._id) ||
      (calendar.providerCalendarId !== undefined &&
        accessibleIds.has(calendar.providerCalendarId))
    ) {
      continue;
    }
    // Preserve local display preferences while removing inaccessible calendars
    // and their invalid cursors from subsequent pull scheduling.
    await ctx.db.patch(calendar._id, {
      accountId: undefined,
      syncToken: undefined,
      syncCursor: undefined,
      lastSyncAt: undefined,
    });
  }
  return { applied: args.calendars.length };
}

export async function beginRemoteFullSync(
  ctx: MutationCtx,
  args: { accountId: string; calendarId: string; providerCalendarId?: string },
): Promise<{ generation: number }> {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.accountId, "CALENDAR_ACCOUNT_ID");
  assertOpaque(args.calendarId, "CALENDAR_ID");
  if (args.accountId.startsWith("gacc_") && args.providerCalendarId === undefined) {
    throw new Error("GOOGLE_PROVIDER_CALENDAR_ID_REQUIRED");
  }
  if (args.providerCalendarId !== undefined) {
    assertOpaque(args.providerCalendarId, "GOOGLE_CALENDAR_ID_INVALID");
  }
  const calendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (query) =>
      query.eq("userId", user.id).eq("googleCalendarId", args.calendarId),
    )
    .unique();
  if (
    !calendar ||
    calendar.accountId !== args.accountId ||
    (args.providerCalendarId !== undefined &&
      calendar.providerCalendarId !== args.providerCalendarId)
  ) {
    throw new Error("CALENDAR_FULL_SYNC_MISMATCH");
  }
  const generation = (calendar.syncGeneration ?? 0) + 1;
  await ctx.db.patch(calendar._id, {
    syncGeneration: generation,
    syncToken: undefined,
    syncCursor: undefined,
  });
  return { generation };
}

export async function heartbeatLease(
  ctx: MutationCtx,
  args: { leaseId: string; leaseDurationMs?: number },
): Promise<{ heartbeated: number }> {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.leaseId, "CALENDAR_LEASE_ID", 128);
  const leaseDurationMs = args.leaseDurationMs ?? 30_000;
  if (
    !Number.isInteger(leaseDurationMs) ||
    leaseDurationMs < MIN_LEASE_MS ||
    leaseDurationMs > MAX_LEASE_MS
  )
    throw new Error("CALENDAR_LEASE_DURATION_INVALID");
  const rows = await ctx.db
    .query("calendarOperations")
    .withIndex("by_user_and_leaseId", (query) =>
      query.eq("userId", user.id).eq("leaseId", args.leaseId),
    )
    .take(MAX_LEASE_GROUP_ROWS + 1);
  if (rows.length > MAX_LEASE_GROUP_ROWS) {
    throw new Error("CALENDAR_LEASE_GROUP_TOO_LARGE");
  }
  const leaseExpiresAt = Date.now() + leaseDurationMs;
  let heartbeated = 0;
  for (const row of rows) {
    if (row.state !== "syncing") continue;
    await ctx.db.patch(row._id, {
      leaseExpiresAt,
      nextLeaseAt: leaseExpiresAt,
    });
    heartbeated += 1;
  }
  return { heartbeated };
}

export async function recordRemoteRetry(
  ctx: MutationCtx,
  args: {
    operationId: string;
    leaseId: string;
    safeError: string;
    retryAt: number;
  },
): Promise<null> {
  const user = await requireDesktopBroker(ctx);
  const operation = await operationById(ctx, user.id, args.operationId);
  assertLease(operation, args.leaseId);
  assertOpaque(args.safeError, "CALENDAR_SAFE_ERROR", MAX_SAFE_ERROR_BYTES);
  if (!Number.isFinite(args.retryAt) || args.retryAt < Date.now()) {
    throw new Error("CALENDAR_RETRY_AT_INVALID");
  }
  const group = await leasedOperationGroup(
    ctx,
    user.id,
    operation,
    args.leaseId,
  );
  for (const row of group) {
    const state =
      row.leasePreviousState === "ambiguous" ? "ambiguous" : "pending";
    await ctx.db.patch(row._id, {
      state,
      status: legacyStatusFor(state),
      leaseReady: row.operationId === operation.operationId,
      nextLeaseAt: args.retryAt,
      retryAt: args.retryAt,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      leasePreviousState: undefined,
      safeError: args.safeError,
      lastError: args.safeError,
      updatedAt: Date.now(),
    });
  }
  return null;
}

export async function recordRemoteFailure(
  ctx: MutationCtx,
  args: { operationId: string; leaseId: string; safeError: string },
): Promise<null> {
  const user = await requireDesktopBroker(ctx);
  const operation = await operationById(ctx, user.id, args.operationId);
  assertLease(operation, args.leaseId);
  assertOpaque(args.safeError, "CALENDAR_SAFE_ERROR", MAX_SAFE_ERROR_BYTES);
  const group = await leasedOperationGroup(
    ctx,
    user.id,
    operation,
    args.leaseId,
  );
  for (const row of group) {
    await ctx.db.patch(row._id, {
      state: "failed",
      status: "failed",
      leaseReady: false,
      nextLeaseAt: 0,
      retryAt: undefined,
      leaseId: undefined,
      leaseExpiresAt: undefined,
      leasePreviousState: undefined,
      leaseLeaderOperationId: undefined,
      safeError: args.safeError,
      lastError: args.safeError,
      updatedAt: Date.now(),
    });
  }
  return null;
}

export async function releaseLease(
  ctx: MutationCtx,
  args: { leaseId: string },
): Promise<{ released: number }> {
  const user = await requireDesktopBroker(ctx);
  assertOpaque(args.leaseId, "CALENDAR_LEASE_ID", 128);
  const leased = await ctx.db
    .query("calendarOperations")
    .withIndex("by_user_and_leaseId", (query) =>
      query.eq("userId", user.id).eq("leaseId", args.leaseId),
    )
    .take(MAX_LEASE_GROUP_ROWS + 1);
  if (leased.length > MAX_LEASE_GROUP_ROWS) {
    throw new Error("CALENDAR_LEASE_GROUP_TOO_LARGE");
  }
  let released = 0;
  for (const operation of leased) {
    if (operation.state !== "syncing") continue;
    // Google may have committed before its Convex receipt was stored. Every
    // released or crashed write therefore re-enters reconciliation.
    const restoredState = "ambiguous" as const;
    await ctx.db.patch(operation._id, {
      state: restoredState,
      status: legacyStatusFor(restoredState),
      leaseReady:
        operation.leaseLeaderOperationId === undefined ||
        operation.operationId === operation.leaseLeaderOperationId,
      nextLeaseAt: Date.now(),
      leaseId: undefined,
      leaseExpiresAt: undefined,
      leasePreviousState: undefined,
      updatedAt: Date.now(),
    });
    released += 1;
  }
  return { released };
}
