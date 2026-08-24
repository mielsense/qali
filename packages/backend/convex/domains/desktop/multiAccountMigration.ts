import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type {
  CalendarEventSnapshot,
  CalendarOperationPayload,
} from "../calendar/operations";
import {
  googleAccountIdForSubject,
  googleCalendarKey,
} from "../calendar/providerIdentity";
import { requireDesktopBroker } from "./identity";

const PAGE_SIZE = 25;
const STABLE_GOOGLE_ACCOUNT_PREFIX = "gacc_";
// Convex filters do not expose startsWith. In UTF-8 lexical order, every
// stable account id is in ["gacc_", "gacc`").
const STABLE_GOOGLE_ACCOUNT_PREFIX_END = "gacc`";
const STAGES = [
  "calendars",
  "events",
  "recurringSeries",
  "calendarOperations",
] as const;
type Stage = (typeof STAGES)[number];
type Mode = "claimed" | "detached";

type Position = Readonly<{
  mode: Mode;
  accountId?: string;
  connectionId: Id<"calendarConnections">;
  stage: Stage;
  cursor: string | null;
}>;

function encodePosition(position: Position): string {
  return JSON.stringify([
    1,
    position.mode,
    position.accountId ?? null,
    position.connectionId,
    position.stage,
    position.cursor,
  ]);
}

function decodePosition(value: string): Position {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 6) throw new Error();
    const [version, mode, accountId, connectionId, stage, cursor] = parsed;
    if (
      version !== 1 ||
      (mode !== "claimed" && mode !== "detached") ||
      (accountId !== null && typeof accountId !== "string") ||
      typeof connectionId !== "string" ||
      typeof stage !== "string" ||
      !STAGES.includes(stage as Stage) ||
      (cursor !== null && typeof cursor !== "string")
    ) {
      throw new Error();
    }
    return {
      mode,
      ...(accountId === null ? {} : { accountId }),
      connectionId: connectionId as Id<"calendarConnections">,
      stage: stage as Stage,
      cursor,
    };
  } catch {
    throw new Error("MIGRATION_CURSOR_INVALID");
  }
}

function belongsToClaimedLegacy(
  row: Readonly<{
    accountId?: string;
    connectionId?: Id<"calendarConnections">;
  }>,
  position: Position,
  connection: Doc<"calendarConnections">,
): boolean {
  if (row.connectionId === position.connectionId) return true;
  if (
    row.connectionId === undefined &&
    position.accountId !== undefined &&
    row.accountId === position.accountId
  ) {
    return true;
  }
  if (connection.legacyMigrationState !== "claimed") return false;
  return (
    row.connectionId === undefined &&
    (row.accountId === undefined ||
      !row.accountId.startsWith(STABLE_GOOGLE_ACCOUNT_PREFIX))
  );
}

function belongsToPosition(
  row: Readonly<{
    accountId?: string;
    connectionId?: Id<"calendarConnections">;
  }>,
  position: Position,
  connection: Doc<"calendarConnections">,
): boolean {
  if (position.mode === "claimed") {
    return belongsToClaimedLegacy(row, position, connection);
  }
  return (
    row.connectionId === position.connectionId ||
    (row.connectionId === undefined &&
      (row.accountId === undefined ||
        !row.accountId.startsWith(STABLE_GOOGLE_ACCOUNT_PREFIX)))
  );
}

function isUnscopedLegacyRow(
  row: Readonly<{
    accountId?: string;
    connectionId?: Id<"calendarConnections">;
  }>,
): boolean {
  return (
    row.connectionId === undefined &&
    (row.accountId === undefined ||
      !row.accountId.startsWith(STABLE_GOOGLE_ACCOUNT_PREFIX))
  );
}

async function rewriteSnapshot(
  snapshot: CalendarEventSnapshot | undefined,
  accountId: string,
  boundProviderCalendarId?: string,
): Promise<CalendarEventSnapshot | undefined> {
  if (!snapshot) return undefined;
  const providerCalendarId =
    snapshot.providerCalendarId ??
    (snapshot.calendarId.startsWith("gcal_")
      ? undefined
      : snapshot.calendarId) ??
    boundProviderCalendarId;
  if (!providerCalendarId)
    throw new Error("LEGACY_PROVIDER_CALENDAR_ID_MISSING");
  return {
    ...snapshot,
    accountId,
    calendarId: await googleCalendarKey(accountId, providerCalendarId),
    providerCalendarId,
  };
}

async function hasUnscopedLegacyData(
  ctx: MutationCtx,
  userId: string,
): Promise<boolean> {
  const [calendar, event, series, operation] = await Promise.all([
    ctx.db
      .query("calendars")
      .withIndex("by_user", (query) => query.eq("userId", userId))
      .filter((query) =>
        query.and(
          query.eq(query.field("connectionId"), undefined),
          query.not(
            query.and(
              query.gte(
                query.field("accountId"),
                STABLE_GOOGLE_ACCOUNT_PREFIX,
              ),
              query.lt(
                query.field("accountId"),
                STABLE_GOOGLE_ACCOUNT_PREFIX_END,
              ),
            ),
          ),
        ),
      )
      .first(),
    ctx.db
      .query("events")
      .withIndex("by_user_and_start", (query) => query.eq("userId", userId))
      .filter((query) =>
        query.and(
          query.eq(query.field("connectionId"), undefined),
          query.not(
            query.and(
              query.gte(
                query.field("accountId"),
                STABLE_GOOGLE_ACCOUNT_PREFIX,
              ),
              query.lt(
                query.field("accountId"),
                STABLE_GOOGLE_ACCOUNT_PREFIX_END,
              ),
            ),
          ),
        ),
      )
      .first(),
    ctx.db
      .query("recurringSeries")
      .withIndex("by_user_and_calendar_and_googleEventId", (query) =>
        query.eq("userId", userId),
      )
      .filter((query) => query.eq(query.field("connectionId"), undefined))
      .first(),
    ctx.db
      .query("calendarOperations")
      .withIndex("by_user_and_status", (query) => query.eq("userId", userId))
      .filter((query) =>
        query.and(
          query.eq(query.field("connectionId"), undefined),
          query.not(
            query.and(
              query.gte(
                query.field("accountId"),
                STABLE_GOOGLE_ACCOUNT_PREFIX,
              ),
              query.lt(
                query.field("accountId"),
                STABLE_GOOGLE_ACCOUNT_PREFIX_END,
              ),
            ),
          ),
        ),
      )
      .first(),
  ]);
  return [calendar, event, series, operation].some((row) => row !== null);
}

async function initializePosition(
  ctx: MutationCtx,
  userId: string,
  args: {
    accountId?: string;
    providerAccountId?: string;
  },
): Promise<Position | null> {
  if (
    (args.accountId === undefined) !==
    (args.providerAccountId === undefined)
  ) {
    throw new Error("GOOGLE_MIGRATION_IDENTITY_INCOMPLETE");
  }
  if (args.accountId !== undefined && args.providerAccountId !== undefined) {
    if (
      (await googleAccountIdForSubject(args.providerAccountId)) !==
      args.accountId
    ) {
      throw new Error("GOOGLE_ACCOUNT_ID_MISMATCH");
    }
    const connection = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user_provider_account", (query) =>
        query
          .eq("userId", userId)
          .eq("provider", "google")
          .eq("accountId", args.accountId),
      )
      .unique();
    if (
      !connection ||
      connection.providerAccountId !== args.providerAccountId
    ) {
      throw new Error("GOOGLE_ACCOUNT_NOT_ATTACHED");
    }
    return {
      mode: "claimed",
      accountId: args.accountId,
      connectionId: connection._id,
      stage: STAGES[0],
      cursor: null,
    };
  }
  const candidates = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_and_provider", (query) =>
      query.eq("userId", userId).eq("provider", "google"),
    )
    .take(10);
  const detached = candidates.filter(
    (row) => row.accountId === undefined && row.providerAccountId === undefined,
  );
  if (detached.length === 0) {
    if (!(await hasUnscopedLegacyData(ctx, userId))) return null;
    const now = Date.now();
    const connectionId = await ctx.db.insert("calendarConnections", {
      userId,
      provider: "google",
      status: "paused",
      lastError: "legacy_identity_required",
      legacyMigrationState: "detached",
      createdAt: now,
      updatedAt: now,
    });
    return {
      mode: "detached",
      connectionId,
      stage: STAGES[0],
      cursor: null,
    };
  }
  if (detached.length > 1) throw new Error("LEGACY_IDENTITY_AMBIGUOUS");
  const connection = detached[0]!;
  await ctx.db.patch(connection._id, {
    status: "paused",
    lastError: "legacy_identity_required",
    legacyMigrationState: "detached",
    updatedAt: Date.now(),
  });
  return {
    mode: "detached",
    connectionId: connection._id,
    stage: STAGES[0],
    cursor: null,
  };
}

async function migrateCalendars(
  ctx: MutationCtx,
  userId: string,
  position: Position,
  connection: Doc<"calendarConnections">,
) {
  const page = await ctx.db.query("calendars").paginate({
    cursor: position.cursor,
    numItems: PAGE_SIZE,
  });
  let migrated = 0;
  for (const row of page.page) {
    if (row.userId !== userId || !belongsToPosition(row, position, connection))
      continue;
    const providerCalendarId = row.providerCalendarId ?? row.googleCalendarId;
    if (position.mode === "detached") {
      await ctx.db.patch(row._id, {
        connectionId: position.connectionId,
        providerCalendarId,
      });
    } else {
      const calendarKey = await googleCalendarKey(
        position.accountId!,
        providerCalendarId,
      );
      const duplicate = await ctx.db
        .query("calendars")
        .withIndex("by_connection_and_providerCalendarId", (query) =>
          query
            .eq("connectionId", position.connectionId)
            .eq("providerCalendarId", providerCalendarId),
        )
        .collect();
      if (duplicate.some((candidate) => candidate._id !== row._id)) {
        throw new Error("GOOGLE_CALENDAR_IDENTITY_CONFLICT");
      }
      await ctx.db.patch(row._id, {
        connectionId: position.connectionId,
        accountId: position.accountId,
        calendarKey,
        googleCalendarId: calendarKey,
        providerCalendarId,
      });
    }
    migrated += 1;
  }
  return { page, migrated };
}

async function migrateEvents(
  ctx: MutationCtx,
  userId: string,
  position: Position,
  connection: Doc<"calendarConnections">,
) {
  const page = await ctx.db.query("events").paginate({
    cursor: position.cursor,
    numItems: PAGE_SIZE,
  });
  let migrated = 0;
  for (const row of page.page) {
    if (row.userId !== userId || !belongsToPosition(row, position, connection))
      continue;
    if (position.mode === "detached") {
      await ctx.db.patch(row._id, { connectionId: position.connectionId });
    } else {
      const remoteSnapshot = row.remoteSnapshot as
        | CalendarEventSnapshot
        | undefined;
      const providerCalendarId = await resolveBoundProviderCalendarId(
        ctx,
        userId,
        position.connectionId,
        row.calendarId,
        remoteSnapshot?.providerCalendarId,
      );
      if (!providerCalendarId)
        throw new Error("LEGACY_PROVIDER_CALENDAR_ID_MISSING");
      await ctx.db.patch(row._id, {
        connectionId: position.connectionId,
        accountId: position.accountId,
        calendarId: await googleCalendarKey(
          position.accountId!,
          providerCalendarId,
        ),
        providerEventId: row.providerEventId ?? row.googleEventId,
        providerUpdatedMs: row.providerUpdatedMs ?? row.googleUpdatedMs,
        remoteSnapshot: await rewriteSnapshot(
          remoteSnapshot,
          position.accountId!,
          providerCalendarId,
        ),
      });
    }
    migrated += 1;
  }
  return { page, migrated };
}

async function migrateRecurringSeries(
  ctx: MutationCtx,
  userId: string,
  position: Position,
  connection: Doc<"calendarConnections">,
) {
  const page = await ctx.db.query("recurringSeries").paginate({
    cursor: position.cursor,
    numItems: PAGE_SIZE,
  });
  let migrated = 0;
  for (const row of page.page) {
    if (
      row.userId !== userId ||
      !belongsToPosition(
        { connectionId: row.connectionId },
        position,
        connection,
      )
    )
      continue;
    if (position.mode === "detached") {
      await ctx.db.patch(row._id, { connectionId: position.connectionId });
    } else {
      const providerCalendarId = await resolveBoundProviderCalendarId(
        ctx,
        userId,
        position.connectionId,
        row.calendarId,
        row.providerCalendarId,
      );
      if (!providerCalendarId)
        throw new Error("LEGACY_PROVIDER_CALENDAR_ID_MISSING");
      await ctx.db.patch(row._id, {
        connectionId: position.connectionId,
        calendarId: await googleCalendarKey(
          position.accountId!,
          providerCalendarId,
        ),
        providerCalendarId,
        providerEventId: row.providerEventId ?? row.googleEventId,
      });
    }
    migrated += 1;
  }
  return { page, migrated };
}

async function resolveBoundProviderCalendarId(
  ctx: MutationCtx,
  userId: string,
  connectionId: Id<"calendarConnections">,
  calendarId: string | undefined,
  providerCalendarId: string | undefined,
): Promise<string | undefined> {
  if (providerCalendarId) return providerCalendarId;
  if (!calendarId) return undefined;
  if (!calendarId.startsWith("gcal_")) return calendarId;
  const membership = await ctx.db
    .query("calendars")
    .withIndex("by_user_and_calendarKey", (query) =>
      query.eq("userId", userId).eq("calendarKey", calendarId),
    )
    .unique();
  if (membership?.connectionId !== connectionId) return undefined;
  return membership.providerCalendarId;
}

async function migrateOperations(
  ctx: MutationCtx,
  userId: string,
  position: Position,
  connection: Doc<"calendarConnections">,
) {
  const page = await ctx.db.query("calendarOperations").paginate({
    cursor: position.cursor,
    numItems: PAGE_SIZE,
  });
  let migrated = 0;
  for (const row of page.page) {
    if (row.userId !== userId || !belongsToPosition(row, position, connection))
      continue;
    if (position.mode === "detached") {
      await ctx.db.patch(row._id, { connectionId: position.connectionId });
      migrated += 1;
      continue;
    }
    const providerCalendarId = await resolveBoundProviderCalendarId(
      ctx,
      userId,
      position.connectionId,
      row.calendarId,
      row.providerCalendarId,
    );
    if (!providerCalendarId)
      throw new Error("LEGACY_PROVIDER_CALENDAR_ID_MISSING");
    let payload = row.payload as CalendarOperationPayload | undefined;
    if (payload && "event" in payload) {
      payload = {
        event: (await rewriteSnapshot(
          payload.event,
          position.accountId!,
          providerCalendarId,
        ))!,
      };
    } else if (payload && "destinationCalendarId" in payload) {
      const destinationProviderCalendarId =
        await resolveBoundProviderCalendarId(
          ctx,
          userId,
          position.connectionId,
          payload.destinationCalendarId,
          payload.destinationProviderCalendarId,
        );
      if (!destinationProviderCalendarId) {
        throw new Error("LEGACY_PROVIDER_CALENDAR_ID_MISSING");
      }
      payload = {
        destinationCalendarId: await googleCalendarKey(
          position.accountId!,
          destinationProviderCalendarId,
        ),
        destinationProviderCalendarId,
      };
    }
    await ctx.db.patch(row._id, {
      connectionId: position.connectionId,
      accountId: position.accountId,
      calendarId: await googleCalendarKey(
        position.accountId!,
        providerCalendarId,
      ),
      providerCalendarId,
      payload,
      baseRemoteSnapshot: await rewriteSnapshot(
        row.baseRemoteSnapshot as CalendarEventSnapshot | undefined,
        position.accountId!,
        providerCalendarId,
      ),
      uploadBaseRemoteSnapshot: await rewriteSnapshot(
        row.uploadBaseRemoteSnapshot as CalendarEventSnapshot | undefined,
        position.accountId!,
        providerCalendarId,
      ),
    });
    migrated += 1;
  }
  return { page, migrated };
}

/** Restartable expand-phase graph rewrite. Cursors bind mode/account/connection. */
export async function migrateLegacyGoogleData(
  ctx: MutationCtx,
  args: {
    accountId?: string;
    providerAccountId?: string;
    cursor?: string;
  },
): Promise<{ done: boolean; cursor?: string; migrated: number }> {
  const user = await requireDesktopBroker(ctx);
  const position = args.cursor
    ? decodePosition(args.cursor)
    : await initializePosition(ctx, user.id, args);
  if (position === null) return { done: true, migrated: 0 };
  if (
    (position.accountId ?? undefined) !== args.accountId ||
    (position.mode === "claimed" && args.providerAccountId === undefined)
  ) {
    throw new Error("MIGRATION_CURSOR_SCOPE_MISMATCH");
  }
  const connection = await ctx.db.get(position.connectionId);
  if (
    !connection ||
    connection.userId !== user.id ||
    connection.provider !== "google"
  ) {
    throw new Error("MIGRATION_CONNECTION_MISMATCH");
  }
  const result =
    position.stage === "calendars"
      ? await migrateCalendars(ctx, user.id, position, connection)
      : position.stage === "events"
        ? await migrateEvents(ctx, user.id, position, connection)
        : position.stage === "recurringSeries"
          ? await migrateRecurringSeries(ctx, user.id, position, connection)
          : await migrateOperations(ctx, user.id, position, connection);
  if (!result.page.isDone) {
    return {
      done: false,
      cursor: encodePosition({
        ...position,
        cursor: result.page.continueCursor,
      }),
      migrated: result.migrated,
    };
  }
  const next = STAGES[STAGES.indexOf(position.stage) + 1];
  if (next !== undefined) {
    return {
      done: false,
      cursor: encodePosition({ ...position, stage: next, cursor: null }),
      migrated: result.migrated,
    };
  }
  if (position.mode === "claimed") {
    await ctx.db.patch(connection._id, {
      legacyMigrationState: "complete",
      updatedAt: Date.now(),
    });
  }
  return { done: true, migrated: result.migrated };
}

function snapshotMatchesAccount(
  snapshot: CalendarEventSnapshot | undefined,
  accountId: string,
): Promise<boolean> {
  if (!snapshot?.providerCalendarId) return Promise.resolve(false);
  return googleCalendarKey(accountId, snapshot.providerCalendarId).then(
    (key) => snapshot.accountId === accountId && snapshot.calendarId === key,
  );
}

/** Paged, read-only postcondition. Callers must sum `violations` through done. */
export async function auditGoogleAccountMigration(
  ctx: QueryCtx,
  args: { accountId: string; cursor?: string },
): Promise<{
  done: boolean;
  cursor?: string;
  checked: number;
  violations: number;
  stage: Stage;
}> {
  const user = await requireDesktopBroker(ctx);
  const connection = await ctx.db
    .query("calendarConnections")
    .withIndex("by_user_provider_account", (query) =>
      query
        .eq("userId", user.id)
        .eq("provider", "google")
        .eq("accountId", args.accountId),
    )
    .unique();
  if (!connection) throw new Error("GOOGLE_ACCOUNT_NOT_ATTACHED");
  const position = args.cursor
    ? decodePosition(args.cursor)
    : {
        mode: "claimed" as const,
        accountId: args.accountId,
        connectionId: connection._id,
        stage: STAGES[0],
        cursor: null,
      };
  if (
    position.mode !== "claimed" ||
    position.accountId !== args.accountId ||
    position.connectionId !== connection._id
  ) {
    throw new Error("MIGRATION_CURSOR_SCOPE_MISMATCH");
  }
  let checked = 0;
  let violations = 0;
  let isDone = false;
  let continueCursor = "";
  if (position.stage === "calendars") {
    const page = await ctx.db.query("calendars").paginate({
      cursor: position.cursor,
      numItems: PAGE_SIZE,
    });
    isDone = page.isDone;
    continueCursor = page.continueCursor;
    for (const row of page.page) {
      if (
        row.userId !== user.id ||
        (row.accountId !== args.accountId &&
          row.connectionId !== connection._id &&
          !isUnscopedLegacyRow(row))
      )
        continue;
      checked += 1;
      const expected = row.providerCalendarId
        ? await googleCalendarKey(args.accountId, row.providerCalendarId)
        : undefined;
      if (
        row.connectionId !== connection._id ||
        row.calendarKey !== expected ||
        row.googleCalendarId !== expected
      )
        violations += 1;
    }
  } else if (position.stage === "events") {
    const page = await ctx.db.query("events").paginate({
      cursor: position.cursor,
      numItems: PAGE_SIZE,
    });
    isDone = page.isDone;
    continueCursor = page.continueCursor;
    for (const row of page.page) {
      if (
        row.userId !== user.id ||
        (row.accountId !== args.accountId &&
          row.connectionId !== connection._id &&
          !isUnscopedLegacyRow(row))
      )
        continue;
      checked += 1;
      const snapshot = row.remoteSnapshot as CalendarEventSnapshot | undefined;
      // This audit proves account and connection ownership. It must not turn
      // incomplete sync metadata into a startup failure: databases created by
      // older Qali builds can contain valid local-first rows without the newer
      // provider identity fields, and the sync queue repairs those separately.
      if (
        row.connectionId !== connection._id ||
        row.accountId !== args.accountId ||
        (snapshot !== undefined &&
          (!(await snapshotMatchesAccount(snapshot, args.accountId)) ||
            row.calendarId !== snapshot.calendarId))
      )
        violations += 1;
    }
  } else if (position.stage === "recurringSeries") {
    const page = await ctx.db.query("recurringSeries").paginate({
      cursor: position.cursor,
      numItems: PAGE_SIZE,
    });
    isDone = page.isDone;
    continueCursor = page.continueCursor;
    for (const row of page.page) {
      if (
        row.userId !== user.id ||
        (row.connectionId !== connection._id && row.connectionId !== undefined)
      )
        continue;
      checked += 1;
      const expected = row.providerCalendarId
        ? await googleCalendarKey(args.accountId, row.providerCalendarId)
        : undefined;
      if (row.calendarId !== expected || row.providerEventId === undefined) {
        violations += 1;
      }
    }
  } else {
    const page = await ctx.db.query("calendarOperations").paginate({
      cursor: position.cursor,
      numItems: PAGE_SIZE,
    });
    isDone = page.isDone;
    continueCursor = page.continueCursor;
    for (const row of page.page) {
      if (
        row.userId !== user.id ||
        (row.accountId !== args.accountId &&
          row.connectionId !== connection._id &&
          !isUnscopedLegacyRow(row))
      )
        continue;
      checked += 1;
      const expected = row.providerCalendarId
        ? await googleCalendarKey(args.accountId, row.providerCalendarId)
        : undefined;
      let validPayload = true;
      const payload = row.payload as CalendarOperationPayload | undefined;
      if (payload && "event" in payload) {
        validPayload = await snapshotMatchesAccount(
          payload.event,
          args.accountId,
        );
      } else if (payload && "destinationCalendarId" in payload) {
        validPayload =
          payload.destinationProviderCalendarId !== undefined &&
          payload.destinationCalendarId ===
            (await googleCalendarKey(
              args.accountId,
              payload.destinationProviderCalendarId,
            ));
      }
      if (
        row.connectionId !== connection._id ||
        row.calendarId !== expected ||
        !validPayload ||
        (row.baseRemoteSnapshot !== undefined &&
          !(await snapshotMatchesAccount(
            row.baseRemoteSnapshot as CalendarEventSnapshot,
            args.accountId,
          ))) ||
        (row.uploadBaseRemoteSnapshot !== undefined &&
          !(await snapshotMatchesAccount(
            row.uploadBaseRemoteSnapshot as CalendarEventSnapshot,
            args.accountId,
          )))
      )
        violations += 1;
    }
  }
  if (!isDone) {
    return {
      done: false,
      cursor: encodePosition({ ...position, cursor: continueCursor }),
      checked,
      violations,
      stage: position.stage,
    };
  }
  const next = STAGES[STAGES.indexOf(position.stage) + 1];
  if (next !== undefined) {
    return {
      done: false,
      cursor: encodePosition({ ...position, stage: next, cursor: null }),
      checked,
      violations,
      stage: position.stage,
    };
  }
  return {
    done: true,
    checked,
    violations:
      violations + (connection.legacyMigrationState === "complete" ? 0 : 1),
    stage: position.stage,
  };
}
