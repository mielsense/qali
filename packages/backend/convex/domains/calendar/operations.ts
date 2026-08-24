import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { reducePendingOperations } from "./projection";

export const CALENDAR_OPERATION_STATES = [
  "pending",
  "syncing",
  "succeeded",
  "conflict",
  "ambiguous",
  "failed",
  "cancelled",
] as const;

export type CalendarOperationState =
  (typeof CALENDAR_OPERATION_STATES)[number];

export type CalendarEventSnapshot = Readonly<{
  localEventId: string;
  accountId: string;
  calendarId: string;
  providerCalendarId?: string;
  remoteEventId?: string;
  summary?: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  status: string;
  timeZone?: string;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  recurrence?: string[];
  recurrenceScope?: "thisEvent" | "thisAndFollowing" | "allEvents";
  attendees?: Array<Readonly<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
    organizer?: boolean;
    self?: boolean;
  }>>;
  responseStatus?: string;
  conference?: Readonly<{
    type?: string;
    name?: string;
    url?: string;
    requestId?: string;
  }> | null;
  conferenceUrl?: string;
  conferenceName?: string;
  conferenceType?: string;
  hangoutLink?: string;
  [key: string]: unknown;
}>;

export type CalendarEventPatch = Readonly<
  Partial<
    Omit<
      CalendarEventSnapshot,
      "localEventId" | "accountId" | "calendarId" | "remoteEventId"
    >
  >
>;

export type CalendarOperationPayload =
  | Readonly<{ event: CalendarEventSnapshot }>
  | Readonly<{ patch: CalendarEventPatch }>
  | Readonly<{
      destinationCalendarId: string;
      destinationProviderCalendarId?: string;
    }>
  | Readonly<{ responseStatus: "accepted" | "tentative" | "declined" }>
  | Readonly<{
      recurrenceScope?: "thisEvent" | "thisAndFollowing" | "allEvents";
    }>;

export type CalendarOperation = Readonly<{
  operationId: string;
  accountId: string;
  calendarId: string;
  localEventId: string;
  remoteEventId?: string;
  kind: "create" | "update" | "move" | "respond" | "delete";
  payload: CalendarOperationPayload;
  baseRemoteSnapshot?: CalendarEventSnapshot;
  baseRemoteEtag?: string;
  uploadBaseRemoteSnapshot?: CalendarEventSnapshot;
  uploadBaseRemoteEtag?: string;
  predecessorOperationId?: string;
  state: CalendarOperationState;
  attemptCount: number;
  leaseId?: string;
  leaseExpiresAt?: number;
  leaseLeaderOperationId?: string;
  retryAt?: number;
  safeError?: string;
  createdAt: number;
  updatedAt: number;
}>;

export type CalendarCommand = Readonly<
  Pick<
    CalendarOperation,
    | "operationId"
    | "accountId"
    | "calendarId"
    | "localEventId"
    | "remoteEventId"
    | "kind"
    | "payload"
    | "baseRemoteSnapshot"
    | "baseRemoteEtag"
    | "predecessorOperationId"
  >
>;

const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,1023}$/;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 10_000;
export const MAX_ACTIVE_OPERATION_CHAIN = 128;

const ACTIVE_OPERATION_STATES = [
  "pending",
  "syncing",
  "conflict",
  "ambiguous",
  "failed",
] as const;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertBoundedValue(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error("CALENDAR_COMMAND_INVALID");
  if (typeof value === "string") {
    if (byteLength(value) > MAX_TEXT_BYTES) {
      throw new Error("CALENDAR_COMMAND_TOO_LARGE");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error("CALENDAR_COMMAND_TOO_LARGE");
    for (const entry of value) assertBoundedValue(entry, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 100) throw new Error("CALENDAR_COMMAND_TOO_LARGE");
    for (const [key, entry] of entries) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error("CALENDAR_COMMAND_INVALID");
      }
      assertBoundedValue(entry, depth + 1);
    }
  }
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function assertCalendarCommand(command: CalendarCommand): void {
  if (
    !OPERATION_ID.test(command.operationId) ||
    !OPAQUE_ID.test(command.accountId) ||
    !OPAQUE_ID.test(command.localEventId) ||
    command.calendarId.length === 0 ||
    command.calendarId.length > 1_024 ||
    (command.remoteEventId !== undefined &&
      (command.remoteEventId.length === 0 || command.remoteEventId.length > 1_024)) ||
    (command.predecessorOperationId !== undefined &&
      !OPERATION_ID.test(command.predecessorOperationId)) ||
    !["create", "update", "move", "respond", "delete"].includes(command.kind)
  ) {
    throw new Error("CALENDAR_COMMAND_INVALID");
  }
  const payloadKeys = Object.keys(command.payload);
  const payloadMatchesKind =
    (command.kind === "create" &&
      payloadKeys.length === 1 &&
      "event" in command.payload) ||
    (command.kind === "update" &&
      payloadKeys.length === 1 &&
      "patch" in command.payload) ||
    (command.kind === "move" &&
      (payloadKeys.length === 1 || payloadKeys.length === 2) &&
      "destinationCalendarId" in command.payload &&
      payloadKeys.every((key) =>
        ["destinationCalendarId", "destinationProviderCalendarId"].includes(key),
      )) ||
    (command.kind === "respond" &&
      payloadKeys.length === 1 &&
      "responseStatus" in command.payload) ||
    (command.kind === "delete" &&
      (payloadKeys.length === 0 ||
        (payloadKeys.length === 1 && "recurrenceScope" in command.payload)));
  if (!payloadMatchesKind) {
    throw new Error("CALENDAR_COMMAND_PAYLOAD_MISMATCH");
  }
  if (
    command.kind === "delete" &&
    "recurrenceScope" in command.payload &&
    command.payload.recurrenceScope !== undefined &&
    !["thisEvent", "thisAndFollowing", "allEvents"].includes(
      command.payload.recurrenceScope,
    )
  ) {
    throw new Error("CALENDAR_COMMAND_PAYLOAD_MISMATCH");
  }
  if (
    command.kind === "update" &&
    "patch" in command.payload &&
    ("calendarId" in command.payload.patch ||
      "remoteEventId" in command.payload.patch)
  ) {
    throw new Error("CALENDAR_COMMAND_IDENTITY_MUTATION");
  }
  const snapshotInScope = (snapshot: CalendarEventSnapshot): boolean =>
    snapshot.accountId === command.accountId &&
    snapshot.localEventId === command.localEventId &&
    snapshot.calendarId === command.calendarId &&
    (command.remoteEventId === undefined ||
      snapshot.remoteEventId === command.remoteEventId);
  if (
    (command.baseRemoteSnapshot !== undefined &&
      !snapshotInScope(command.baseRemoteSnapshot)) ||
    ("event" in command.payload && !snapshotInScope(command.payload.event))
  ) {
    throw new Error("CALENDAR_COMMAND_SCOPE_MISMATCH");
  }
  const remoteScoped =
    command.remoteEventId !== undefined ||
    command.baseRemoteSnapshot?.remoteEventId !== undefined;
  if (
    command.kind !== "create" &&
    remoteScoped &&
    (command.remoteEventId === undefined ||
      command.baseRemoteSnapshot === undefined ||
      command.baseRemoteSnapshot.remoteEventId !== command.remoteEventId ||
      command.baseRemoteEtag === undefined ||
      command.baseRemoteEtag.length === 0)
  ) {
    throw new Error("CALENDAR_COMMAND_PRECONDITION_REQUIRED");
  }
  assertBoundedValue(command.payload);
  if (byteLength(JSON.stringify(command)) > MAX_COMMAND_BYTES) {
    throw new Error("CALENDAR_COMMAND_TOO_LARGE");
  }
}

/** Active projection work is deliberately bounded and state-indexed. Terminal
 * immutable history is never revisited, while an unexpectedly large live chain
 * fails closed before a mutation can perform an unbounded scan. */
export async function activeOperationRowsForEvent(
  ctx: MutationCtx,
  userId: string,
  localEventId: string,
): Promise<Doc<"calendarOperations">[]> {
  const rows: Doc<"calendarOperations">[] = [];
  for (const state of ACTIVE_OPERATION_STATES) {
    const stateRows = await ctx.db
      .query("calendarOperations")
      .withIndex(
        "by_user_and_localEvent_and_state_and_createdAt",
        (query) =>
          query
            .eq("userId", userId)
            .eq("localEventId", localEventId)
            .eq("state", state),
      )
      .take(MAX_ACTIVE_OPERATION_CHAIN + 1);
    rows.push(...stateRows);
    if (rows.length > MAX_ACTIVE_OPERATION_CHAIN) {
      throw new Error("CALENDAR_ACTIVE_CHAIN_TOO_LARGE");
    }
  }
  return rows.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      (left.operationId ?? left.idempotencyKey).localeCompare(
        right.operationId ?? right.idempotencyKey,
      ),
  );
}

function compareOperations(
  left: CalendarOperation,
  right: CalendarOperation,
): number {
  return left.createdAt - right.createdAt ||
    left.operationId.localeCompare(right.operationId);
}

/** Stable topological ordering. A predecessor serializes an event even when
 * timestamps tie or rows are returned by a different index order. */
export function orderCalendarOperations(
  operations: readonly CalendarOperation[],
): CalendarOperation[] {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  if (byId.size !== operations.length) {
    throw new Error("DUPLICATE_CALENDAR_OPERATION");
  }
  const remaining = new Set(byId.keys());
  const ordered: CalendarOperation[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((operation) =>
        operation.predecessorOperationId === undefined ||
        !remaining.has(operation.predecessorOperationId),
      )
      .sort(compareOperations);
    if (ready.length === 0) throw new Error("CALENDAR_OPERATION_DEPENDENCY_CYCLE");
    const next = ready[0]!;
    remaining.delete(next.operationId);
    ordered.push(next);
  }
  return ordered;
}

export type CalendarUploadGroup = Readonly<{
  operation: CalendarOperation;
  consumedOperationIds: readonly string[];
}>;

export type CalendarUploadPlan = Readonly<{
  operations: readonly CalendarOperation[];
  uploads: readonly CalendarUploadGroup[];
  cancelledOperationIds: readonly string[];
}>;

function isUploadable(operation: CalendarOperation): boolean {
  return ["pending", "syncing", "ambiguous"].includes(operation.state);
}

function canCompactTogether(
  leader: CalendarOperation,
  candidate: CalendarOperation,
): boolean {
  if (leader.state === "pending") return candidate.state === "pending";
  return (
    leader.leaseLeaderOperationId !== undefined &&
    candidate.state === leader.state &&
    candidate.leaseLeaderOperationId === leader.leaseLeaderOperationId
  );
}

/** Builds the deterministic upload plan while retaining the immutable source
 * operation ids that one remote result must acknowledge transactionally. */
export function planCalendarOperationUploads(
  operations: readonly CalendarOperation[],
): CalendarUploadPlan {
  const ordered = orderCalendarOperations(operations);
  const result: CalendarOperation[] = [];
  const uploads: CalendarUploadGroup[] = [];
  const cancelledOperationIds: string[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    if (!isUploadable(current)) {
      result.push(current);
      continue;
    }
    if (current.kind === "update" && "patch" in current.payload) {
      let patch = { ...current.payload.patch };
      const consumed = [current.operationId];
      for (let cursor = index + 1; cursor < ordered.length; cursor += 1) {
        const candidate = ordered[cursor]!;
        if (
          !canCompactTogether(current, candidate) ||
          candidate.localEventId !== current.localEventId ||
          candidate.accountId !== current.accountId ||
          candidate.kind !== "update" ||
          !("patch" in candidate.payload)
        ) break;
        patch = { ...patch, ...candidate.payload.patch };
        consumed.push(candidate.operationId);
      }
      const compacted = { ...current, payload: { patch } };
      result.push(compacted);
      uploads.push({ operation: compacted, consumedOperationIds: consumed });
      index += consumed.length - 1;
      continue;
    }
    if (current.kind !== "create" || !("event" in current.payload)) {
      result.push(current);
      uploads.push({
        operation: current,
        consumedOperationIds: [current.operationId],
      });
      continue;
    }

    let event = { ...current.payload.event };
    let cancelled = false;
    const consumed: CalendarOperation[] = [];
    let cursor = index + 1;
    while (cursor < ordered.length) {
      const candidate = ordered[cursor]!;
      if (
        !canCompactTogether(current, candidate) ||
        candidate.localEventId !== current.localEventId ||
        candidate.accountId !== current.accountId ||
        candidate.kind === "move"
      ) break;
      if (candidate.kind === "update" && "patch" in candidate.payload) {
        event = { ...event, ...candidate.payload.patch };
        consumed.push(candidate);
        cursor += 1;
        continue;
      }
      if (candidate.kind === "delete") {
        result.push(
          { ...current, state: "cancelled" },
          ...consumed.map((entry) => ({ ...entry, state: "cancelled" as const })),
          { ...candidate, state: "cancelled" },
        );
        cancelledOperationIds.push(
          current.operationId,
          ...consumed.map((entry) => entry.operationId),
          candidate.operationId,
        );
        index = cursor;
        cancelled = true;
        break;
      }
      break;
    }
    if (!cancelled) {
      const compacted = { ...current, payload: { event } };
      result.push(compacted);
      uploads.push({
        operation: compacted,
        consumedOperationIds: [
          current.operationId,
          ...consumed.map((entry) => entry.operationId),
        ],
      });
    }
    if (!cancelled) index += consumed.length;
  }
  return { operations: result, uploads, cancelledOperationIds };
}

/** Conservative pure compaction view used by reducers and tests. */
export function compactCalendarOperations(
  operations: readonly CalendarOperation[],
): CalendarOperation[] {
  return [...planCalendarOperationUploads(operations).operations];
}

export async function enqueueCalendarOperation(
  ctx: MutationCtx,
  userId: string,
  incomingCommand: CalendarCommand,
): Promise<Id<"calendarOperations">> {
  assertCalendarCommand(incomingCommand);
  const sourceCalendar = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_googleCalendarId", (query) =>
      query
        .eq("userId", userId)
        .eq("googleCalendarId", incomingCommand.calendarId),
    )
    .unique();
  if (
    sourceCalendar?.accountId !== undefined &&
    sourceCalendar.accountId !== incomingCommand.accountId
  ) {
    throw new Error("CALENDAR_COMMAND_SCOPE_MISMATCH");
  }
  let payload = incomingCommand.payload;
  if (incomingCommand.kind === "move" && "destinationCalendarId" in payload) {
    const destinationCalendarId = payload.destinationCalendarId;
    const destination = await ctx.db
      .query("calendars")
      .withIndex("by_user_and_googleCalendarId", (query) =>
        query
          .eq("userId", userId)
          .eq("googleCalendarId", destinationCalendarId),
      )
      .unique();
    if (
      destination?.accountId !== undefined &&
      destination.accountId !== incomingCommand.accountId
    ) {
      throw new Error("CALENDAR_COMMAND_SCOPE_MISMATCH");
    }
    if (!destination && incomingCommand.calendarId.startsWith("gcal_")) {
      throw new Error("CALENDAR_DESTINATION_NOT_FOUND");
    }
    payload = {
      destinationCalendarId,
      ...(destination?.providerCalendarId === undefined
        ? payload.destinationProviderCalendarId === undefined
          ? {}
          : {
              destinationProviderCalendarId:
                payload.destinationProviderCalendarId,
            }
        : { destinationProviderCalendarId: destination.providerCalendarId }),
    };
  }
  const command: CalendarCommand = { ...incomingCommand, payload };
  const existing = await ctx.db
    .query("calendarOperations")
    .withIndex("by_user_and_operationId", (query) =>
      query.eq("userId", userId).eq("operationId", command.operationId),
    )
    .unique();
  if (existing) {
    const sameCommand =
      existing.accountId === command.accountId &&
      existing.calendarId === command.calendarId &&
      existing.localEventId === command.localEventId &&
      existing.remoteEventId === command.remoteEventId &&
      existing.kind === command.kind &&
      canonicalJson(existing.payload) === canonicalJson(command.payload) &&
      existing.baseRemoteEtag === command.baseRemoteEtag &&
      canonicalJson(existing.baseRemoteSnapshot) ===
        canonicalJson(command.baseRemoteSnapshot) &&
      existing.predecessorOperationId ===
        (command.predecessorOperationId ?? existing.predecessorOperationId);
    if (!sameCommand) throw new Error("CALENDAR_OPERATION_IDEMPOTENCY_MISMATCH");
    return existing._id;
  }

  const eventRows = await ctx.db
    .query("events")
    .withIndex("by_user_and_localEventId", (query) =>
      query.eq("userId", userId).eq("localEventId", command.localEventId),
    )
    .collect();
  const event = eventRows[0];
  if (eventRows.length > 1) throw new Error("DUPLICATE_LOCAL_EVENT_ID");
  const confirmedBaseline = event?.remoteSnapshot as
    | CalendarEventSnapshot
    | undefined;
  if (
    event &&
    (event.accountId !== command.accountId ||
      event.calendarId !== command.calendarId)
  ) {
    throw new Error("CALENDAR_COMMAND_SCOPE_MISMATCH");
  }
  if (
    command.kind !== "create" &&
    confirmedBaseline?.remoteEventId !== undefined &&
    (command.remoteEventId !== confirmedBaseline.remoteEventId ||
      command.baseRemoteSnapshot === undefined ||
      command.baseRemoteEtag === undefined)
  ) {
    throw new Error("CALENDAR_COMMAND_PRECONDITION_REQUIRED");
  }
  if (
    command.kind !== "create" &&
    confirmedBaseline !== undefined &&
    (canonicalJson(command.baseRemoteSnapshot) !==
      canonicalJson(confirmedBaseline) ||
      command.baseRemoteEtag !== event?.remoteEtag)
  ) {
    throw new Error("CALENDAR_COMMAND_PRECONDITION_MISMATCH");
  }

  const latest = command.predecessorOperationId === undefined
    ? (
        await ctx.db
          .query("calendarOperations")
          .withIndex("by_user_and_localEvent_and_createdAt", (query) =>
            query.eq("userId", userId).eq("localEventId", command.localEventId),
          )
          .order("desc")
          .take(1)
      )[0]
    : undefined;
  const explicitPredecessor = command.predecessorOperationId === undefined
    ? undefined
    : await ctx.db
        .query("calendarOperations")
        .withIndex("by_user_and_operationId", (query) =>
          query
            .eq("userId", userId)
            .eq("operationId", command.predecessorOperationId),
        )
        .unique();
  if (
    explicitPredecessor &&
    (explicitPredecessor.accountId !== command.accountId ||
      explicitPredecessor.calendarId !== command.calendarId ||
      explicitPredecessor.localEventId !== command.localEventId)
  ) {
    throw new Error("CALENDAR_OPERATION_PREDECESSOR_MISMATCH");
  }
  if (command.predecessorOperationId !== undefined && !explicitPredecessor) {
    throw new Error("CALENDAR_OPERATION_PREDECESSOR_MISMATCH");
  }
  const predecessor = explicitPredecessor ?? latest;
  const predecessorOperationId = predecessor?.operationId;

  const now = Date.now();
  const operationId = await ctx.db.insert("calendarOperations", {
    connectionId: sourceCalendar?.connectionId ?? event?.connectionId,
    userId,
    operationId: command.operationId,
    idempotencyKey: command.operationId,
    accountId: command.accountId,
    calendarId: command.calendarId,
    localEventId: command.localEventId,
    remoteEventId: command.remoteEventId,
    providerCalendarId:
      sourceCalendar?.providerCalendarId ?? command.calendarId,
    providerEventId: command.remoteEventId,
    kind: command.kind,
    payload: command.payload,
    baseRemoteSnapshot: command.baseRemoteSnapshot,
    baseRemoteEtag: command.baseRemoteEtag,
    uploadBaseRemoteSnapshot: command.baseRemoteSnapshot,
    uploadBaseRemoteEtag: command.baseRemoteEtag,
    predecessorOperationId,
    leaseReady:
      predecessor === undefined ||
      predecessor.state === "succeeded" ||
      predecessor.state === "cancelled",
    nextLeaseAt: 0,
    state: "pending",
    status: "pending",
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  const rows = await activeOperationRowsForEvent(
    ctx,
    userId,
    command.localEventId,
  );
  const operations = rows.flatMap((row) => {
    if (
      !row.operationId ||
      !row.accountId ||
      !row.calendarId ||
      !row.localEventId ||
      !row.payload ||
      !row.state
    ) return [];
    return [{
      operationId: row.operationId,
      accountId: row.accountId,
      calendarId: row.calendarId,
      localEventId: row.localEventId,
      remoteEventId: row.remoteEventId,
      kind: row.kind,
      payload: row.payload as CalendarOperationPayload,
      baseRemoteSnapshot: row.baseRemoteSnapshot as CalendarEventSnapshot | undefined,
      baseRemoteEtag: row.baseRemoteEtag,
      uploadBaseRemoteSnapshot: row.uploadBaseRemoteSnapshot as
        | CalendarEventSnapshot
        | undefined,
      uploadBaseRemoteEtag: row.uploadBaseRemoteEtag,
      predecessorOperationId: row.predecessorOperationId,
      state: row.state,
      attemptCount: row.attemptCount ?? 0,
      leaseId: row.leaseId,
      leaseExpiresAt: row.leaseExpiresAt,
      leaseLeaderOperationId: row.leaseLeaderOperationId,
      retryAt: row.retryAt,
      safeError: row.safeError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies CalendarOperation];
  });
  const baseline =
    (event?.remoteSnapshot as CalendarEventSnapshot | undefined) ??
    command.baseRemoteSnapshot;
  const projection = reducePendingOperations(baseline ?? null, operations);
  if (projection === null) {
    if (event) await ctx.db.delete(event._id);
    return operationId;
  }
  const renderedFields = new Set([
    "calendarId",
    "googleEventId",
    "summary",
    "description",
    "location",
    "startMs",
    "endMs",
    "allDay",
    "status",
    "colorId",
    "visibility",
    "transparency",
    "attendees",
    "hangoutLink",
    "conferenceUrl",
    "conferenceName",
    "conferenceType",
  ]);
  const existingFields = event
    ? Object.fromEntries(
        Object.entries(event).filter(
          ([key]) =>
            key !== "_id" &&
            key !== "_creationTime" &&
            !renderedFields.has(key),
        ),
      )
    : {};
  const projectedFields = Object.fromEntries(
    Object.entries({
      calendarId: projection.calendarId,
      googleEventId:
        projection.remoteEventId ?? event?.googleEventId ?? `local-${projection.localEventId}`,
      summary: typeof projection.summary === "string" ? projection.summary : undefined,
      description:
        typeof projection.description === "string" ? projection.description : undefined,
      location:
        typeof projection.location === "string" ? projection.location : undefined,
      startMs: projection.startMs,
      endMs: projection.endMs,
      allDay: projection.allDay,
      status: projection.status,
      colorId: typeof projection.colorId === "string" ? projection.colorId : undefined,
      visibility:
        typeof projection.visibility === "string" ? projection.visibility : undefined,
      transparency:
        typeof projection.transparency === "string" ? projection.transparency : undefined,
      attendees: projection.attendees?.map((attendee) => ({ ...attendee })),
      hangoutLink:
        typeof projection.hangoutLink === "string" ? projection.hangoutLink : undefined,
      conferenceUrl:
        typeof projection.conferenceUrl === "string" ? projection.conferenceUrl : undefined,
      conferenceName:
        typeof projection.conferenceName === "string" ? projection.conferenceName : undefined,
      conferenceType:
        typeof projection.conferenceType === "string" ? projection.conferenceType : undefined,
    }).filter(([, value]) => value !== undefined),
  );
  const eventValue = {
    ...existingFields,
    ...projectedFields,
    userId,
    localEventId: command.localEventId,
    accountId: command.accountId,
    syncState: projection.syncState,
    googleUpdatedMs: event?.googleUpdatedMs ?? 0,
    ...(baseline ? { remoteSnapshot: baseline } : {}),
    ...(command.baseRemoteEtag !== undefined
      ? { remoteEtag: command.baseRemoteEtag }
      : {}),
  } as unknown as Omit<Doc<"events">, "_id" | "_creationTime">;
  if (event) await ctx.db.replace(event._id, eventValue);
  else await ctx.db.insert("events", eventValue);
  return operationId;
}
