import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { assistantCoordinatorAttemptIdSchema } from "@qali/desktop-contracts";

import type { LocalJwtTokenProvider } from "../auth/jwt";
import type { AssistantCalendarReadClient } from "../codex/calendar-reader";
import type { AssistantBroker, AssistantFailure } from "../codex/coordinator";
import {
  AssistantAttemptContext,
  type FinalizerOutputValue,
} from "../codex/schemas";
import type { GoogleCalendar } from "../google/types";
import type {
  CalendarBrokerPort,
  LeasedCalendarOperation,
  SyncCalendar,
} from "../google/sync-worker";

type BrokerClientOptions = Readonly<{
  accountId?: string;
  client?: ConvexClient;
  deploymentUrl: string;
  tokenProvider: LocalJwtTokenProvider;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}>;

type JsonObject = Record<string, unknown>;

/** Provider-neutral event input. Raw App Server frames, stderr, native IDs,
 * and arbitrary diagnostics intentionally have no representation here. */
export type AssistantAttemptEventInput =
  | {
      kind: "provider_readiness";
      readiness:
        | "ready"
        | "ready_degraded"
        | "authentication_required"
        | "incompatible"
        | "unavailable";
      evidenceDigest?: string;
    }
  | {
      kind: "phase";
      phase: "planning" | "reading" | "finalizing";
      evidenceDigest?: string;
    }
  | { kind: "planner_completed"; evidenceDigest?: string }
  | { kind: "calendar_read_started"; evidenceDigest?: string }
  | { kind: "calendar_read_completed"; evidenceDigest?: string }
  | { kind: "finalizer_completed"; evidenceDigest?: string }
  | { kind: "clarification"; evidenceDigest?: string }
  | { kind: "proposal"; evidenceDigest?: string }
  | {
      kind: "cancel";
      milestone:
        | "requested"
        | "native_cancel_sent"
        | "native_acknowledged"
        | "interrupt_sent"
        | "interrupt_acknowledged"
        | "semantically_interrupted"
        | "completed_before_interrupt"
        | "owned_process_terminated"
        | "outcome_unknown";
      evidenceDigest?: string;
    };

function queryReference(name: string): FunctionReference<"query"> {
  return makeFunctionReference(`desktopCalendar:${name}`);
}

function mutationReference(name: string): FunctionReference<"mutation"> {
  return makeFunctionReference(`desktopCalendar:${name}`);
}

function assistantQueryReference(name: string): FunctionReference<"query"> {
  return makeFunctionReference(`desktopAssistant:${name}`);
}

function assistantMutationReference(
  name: string,
): FunctionReference<"mutation"> {
  return makeFunctionReference(`desktopAssistant:${name}`);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertResultObject(value: unknown, code: string): JsonObject {
  if (!isObject(value)) throw new Error(code);
  return value;
}

function parseSyncState(
  value: unknown,
  expectedAccountId: string,
): {
  calendars: SyncCalendar[];
  pendingCount: number;
  nextRetryAt?: number;
} {
  const object = assertResultObject(value, "CALENDAR_BROKER_RESPONSE_INVALID");
  if (!Array.isArray(object.calendars) || object.calendars.length > 250) {
    throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
  }
  const calendars = object.calendars.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.accountId !== "string" ||
      typeof entry.calendarId !== "string" ||
      typeof entry.providerCalendarId !== "string" ||
      (entry.syncToken !== undefined && typeof entry.syncToken !== "string")
    ) {
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    }
    if (entry.accountId !== expectedAccountId) {
      throw new Error("CALENDAR_BROKER_ACCOUNT_MISMATCH");
    }
    return {
      accountId: entry.accountId,
      calendarId: entry.calendarId,
      providerCalendarId: entry.providerCalendarId,
      ...(typeof entry.syncToken === "string"
        ? { syncToken: entry.syncToken }
        : {}),
    };
  });
  if (
    !Number.isSafeInteger(object.pendingCount) ||
    (object.pendingCount as number) < 0
  ) {
    throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
  }
  if (
    object.nextRetryAt !== undefined &&
    !Number.isFinite(object.nextRetryAt)
  ) {
    throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
  }
  return {
    calendars,
    pendingCount: object.pendingCount as number,
    ...(typeof object.nextRetryAt === "number"
      ? { nextRetryAt: object.nextRetryAt }
      : {}),
  };
}

function parseLeasedOperations(
  value: unknown,
  expectedAccountId: string,
): LeasedCalendarOperation[] {
  if (!Array.isArray(value) || value.length > 25) {
    throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
  }
  return value.map((entry) => {
    if (
      !isObject(entry) ||
      typeof entry.operationId !== "string" ||
      typeof entry.accountId !== "string" ||
      typeof entry.calendarId !== "string" ||
      typeof entry.providerCalendarId !== "string" ||
      typeof entry.localEventId !== "string" ||
      typeof entry.kind !== "string" ||
      !["create", "update", "move", "respond", "delete"].includes(entry.kind) ||
      !isObject(entry.payload) ||
      typeof entry.state !== "string" ||
      typeof entry.attemptCount !== "number" ||
      typeof entry.leaseId !== "string" ||
      typeof entry.leasedFromState !== "string" ||
      !Array.isArray(entry.consumedOperationIds) ||
      !entry.consumedOperationIds.every((id) => typeof id === "string") ||
      typeof entry.createdAt !== "number" ||
      typeof entry.updatedAt !== "number"
    ) {
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    }
    if (entry.accountId !== expectedAccountId) {
      throw new Error("CALENDAR_BROKER_ACCOUNT_MISMATCH");
    }
    return entry as unknown as LeasedCalendarOperation;
  });
}

function parseCount(value: unknown, field: string): number {
  const object = assertResultObject(value, "CALENDAR_BROKER_RESPONSE_INVALID");
  const count = object[field];
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
  }
  return count as number;
}

export class ConvexCalendarBrokerClient
  implements CalendarBrokerPort, AssistantBroker, AssistantCalendarReadClient
{
  readonly #clearTimer: typeof clearTimeout;
  readonly #client: ConvexClient;
  readonly #setTimer: typeof setTimeout;
  readonly #accountId: string | null;
  #closed = false;
  readonly #subscriptionCleanups = new Set<() => void>();

  constructor(options: BrokerClientOptions) {
    const url = new URL(options.deploymentUrl);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("CALENDAR_BROKER_URL_INVALID");
    }
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#client =
      options.client ??
      new ConvexClient(options.deploymentUrl, {
        logger: false,
        unsavedChangesWarning: false,
      });
    this.#client.setAuth(
      async ({ forceRefreshToken }) =>
        await options.tokenProvider.getToken({ forceRefreshToken }),
    );
    this.#accountId = options.accountId ?? null;
  }

  subscribePending(listener: () => void): () => void {
    return this.subscribePendingForAccount(
      this.#requireDefaultAccountId(),
      listener,
    );
  }

  subscribePendingForAccount(
    accountId: string,
    listener: () => void,
  ): () => void {
    if (this.#closed) throw new Error("CALENDAR_BROKER_CLOSED");
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = this.#client.onUpdate(
      queryReference("syncState"),
      { accountId },
      (value) => {
        const state = parseSyncState(value, accountId);
        if (retryTimer !== null) {
          this.#clearTimer(retryTimer);
          retryTimer = null;
        }
        if (state.pendingCount > 0) listener();
        if (state.nextRetryAt !== undefined) {
          retryTimer = this.#setTimer(
            listener,
            Math.max(0, state.nextRetryAt - Date.now()),
          );
        }
      },
      () => {},
    );
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      unsubscribe();
      if (retryTimer !== null) {
        this.#clearTimer(retryTimer);
        retryTimer = null;
      }
      this.#subscriptionCleanups.delete(cleanup);
    };
    this.#subscriptionCleanups.add(cleanup);
    return cleanup;
  }

  forAccount(accountId: string): CalendarBrokerPort {
    if (!accountId) throw new Error("CALENDAR_BROKER_ACCOUNT_INVALID");
    return new AccountScopedCalendarBrokerClient(this, accountId);
  }

  #requireDefaultAccountId(): string {
    if (this.#accountId === null) {
      throw new Error("CALENDAR_BROKER_ACCOUNT_ID_REQUIRED");
    }
    return this.#accountId;
  }

  async listSyncCalendars(accountId: string): Promise<readonly SyncCalendar[]> {
    return parseSyncState(
      await this.#client.query(queryReference("syncState"), { accountId }),
      accountId,
    ).calendars;
  }

  async pendingOperationCount(accountId?: string): Promise<number> {
    const resolvedAccountId = accountId ?? this.#requireDefaultAccountId();
    return parseSyncState(
      await this.#client.query(queryReference("syncState"), {
        accountId: resolvedAccountId,
      }),
      resolvedAccountId,
    ).pendingCount;
  }

  async exportLocalSnapshot(): Promise<unknown> {
    return await this.#client.query(queryReference("exportLocalSnapshot"), {});
  }

  async cleanupLegacyProviderReferences(cursor?: string): Promise<{
    done: boolean;
    cursor?: string;
    cleared: number;
  }> {
    const value = assertResultObject(
      await this.#client.mutation(
        mutationReference("cleanupLegacyProviderReferences"),
        cursor === undefined ? {} : { cursor },
      ),
      "CALENDAR_BROKER_RESPONSE_INVALID",
    );
    if (
      typeof value.done !== "boolean" ||
      !Number.isSafeInteger(value.cleared) ||
      (value.cleared as number) < 0 ||
      (value.cursor !== undefined && typeof value.cursor !== "string") ||
      (value.done === false && typeof value.cursor !== "string")
    ) {
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    }
    return {
      done: value.done,
      ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
      cleared: value.cleared as number,
    };
  }

  async attachGoogleAccount(
    args: Readonly<{
      accountId: string;
      providerAccountId: string;
      accountEmail?: string;
    }>,
  ): Promise<{ connectionId: string; claimedLegacy: boolean }> {
    const value = assertResultObject(
      await this.#client.mutation(
        mutationReference("attachGoogleAccount"),
        args,
      ),
      "CALENDAR_BROKER_RESPONSE_INVALID",
    );
    if (
      typeof value.connectionId !== "string" ||
      typeof value.claimedLegacy !== "boolean"
    )
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    return {
      connectionId: value.connectionId,
      claimedLegacy: value.claimedLegacy,
    };
  }

  async migrateLegacyGoogleData(
    args: Readonly<{
      accountId?: string;
      providerAccountId?: string;
      cursor?: string;
    }>,
  ): Promise<{ done: boolean; cursor?: string; migrated: number }> {
    const value = assertResultObject(
      await this.#client.mutation(
        mutationReference("migrateLegacyGoogleData"),
        args,
      ),
      "CALENDAR_BROKER_RESPONSE_INVALID",
    );
    if (
      typeof value.done !== "boolean" ||
      !Number.isSafeInteger(value.migrated) ||
      (value.migrated as number) < 0 ||
      (value.cursor !== undefined && typeof value.cursor !== "string") ||
      (value.done === false && typeof value.cursor !== "string")
    )
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    return {
      done: value.done,
      ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
      migrated: value.migrated as number,
    };
  }

  async auditGoogleAccountMigration(
    args: Readonly<{
      accountId: string;
      cursor?: string;
    }>,
  ): Promise<{
    done: boolean;
    cursor?: string;
    checked: number;
    violations: number;
    stage: "calendars" | "events" | "recurringSeries" | "calendarOperations";
  }> {
    const value = assertResultObject(
      await this.#client.query(
        queryReference("auditGoogleAccountMigration"),
        args,
      ),
      "CALENDAR_BROKER_RESPONSE_INVALID",
    );
    if (
      typeof value.done !== "boolean" ||
      !Number.isSafeInteger(value.checked) ||
      (value.checked as number) < 0 ||
      !Number.isSafeInteger(value.violations) ||
      (value.violations as number) < 0 ||
      (value.stage !== "calendars" &&
        value.stage !== "events" &&
        value.stage !== "recurringSeries" &&
        value.stage !== "calendarOperations") ||
      (value.cursor !== undefined && typeof value.cursor !== "string") ||
      (value.done === false && typeof value.cursor !== "string")
    )
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    return {
      done: value.done,
      ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
      checked: value.checked as number,
      violations: value.violations as number,
      stage: value.stage,
    };
  }

  async applyRemoteCalendars(
    accountId: string,
    calendars: readonly GoogleCalendar[],
  ): Promise<void> {
    parseCount(
      await this.#client.mutation(mutationReference("applyRemoteCalendars"), {
        accountId,
        calendars: calendars.map((calendar) => ({ ...calendar })),
      }),
      "applied",
    );
  }

  async leaseOperations(
    accountId: string,
    leaseId: string,
    options: Readonly<{ limit?: number; leaseDurationMs?: number }> = {},
  ): Promise<readonly LeasedCalendarOperation[]> {
    return parseLeasedOperations(
      await this.#client.mutation(mutationReference("leaseOperations"), {
        accountId,
        leaseId,
        ...options,
      }),
      accountId,
    );
  }

  async heartbeatLease(leaseId: string, leaseDurationMs?: number) {
    return parseCount(
      await this.#client.mutation(mutationReference("heartbeatLease"), {
        leaseId,
        ...(leaseDurationMs === undefined ? {} : { leaseDurationMs }),
      }),
      "heartbeated",
    );
  }

  async recordRemoteSuccess(
    args: Parameters<CalendarBrokerPort["recordRemoteSuccess"]>[0],
  ) {
    return await this.#client.mutation(
      mutationReference("recordRemoteSuccess"),
      args,
    );
  }

  async recordRemoteAmbiguous(
    args: Parameters<CalendarBrokerPort["recordRemoteAmbiguous"]>[0],
  ) {
    return await this.#client.mutation(
      mutationReference("recordRemoteAmbiguous"),
      args,
    );
  }

  async recordRemoteConflict(
    args: Parameters<CalendarBrokerPort["recordRemoteConflict"]>[0],
  ) {
    return await this.#client.mutation(
      mutationReference("recordRemoteConflict"),
      args,
    );
  }

  async recordRemoteFailure(
    args: Parameters<CalendarBrokerPort["recordRemoteFailure"]>[0],
  ) {
    return await this.#client.mutation(
      mutationReference("recordRemoteFailure"),
      args,
    );
  }

  async recordRemoteRetry(
    args: Parameters<CalendarBrokerPort["recordRemoteRetry"]>[0],
  ) {
    return await this.#client.mutation(
      mutationReference("recordRemoteRetry"),
      args,
    );
  }

  async applyRemotePage(
    args: Parameters<CalendarBrokerPort["applyRemotePage"]>[0],
  ) {
    return parseCount(
      await this.#client.mutation(mutationReference("applyRemotePage"), args),
      "applied",
    );
  }

  async beginRemoteFullSync(
    args: Parameters<CalendarBrokerPort["beginRemoteFullSync"]>[0],
  ) {
    const value = assertResultObject(
      await this.#client.mutation(
        mutationReference("beginRemoteFullSync"),
        args,
      ),
      "CALENDAR_BROKER_RESPONSE_INVALID",
    );
    if (
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 1
    ) {
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    }
    return { generation: value.generation as number };
  }

  async completeRemoteSync(
    args: Parameters<CalendarBrokerPort["completeRemoteSync"]>[0],
  ) {
    const value = assertResultObject(
      await this.#client.mutation(
        mutationReference("completeRemoteSync"),
        args,
      ),
      "CALENDAR_BROKER_RESPONSE_INVALID",
    );
    if (
      typeof value.done !== "boolean" ||
      !Number.isSafeInteger(value.removed) ||
      (value.removed as number) < 0
    ) {
      throw new Error("CALENDAR_BROKER_RESPONSE_INVALID");
    }
    return { done: value.done, removed: value.removed as number };
  }

  async releaseLease(leaseId: string) {
    return parseCount(
      await this.#client.mutation(mutationReference("releaseLease"), {
        leaseId,
      }),
      "released",
    );
  }

  async beginAttempt(
    input: Readonly<{
      attemptId: string;
      text: string;
      timeZone: string;
      nowMs: number;
    }>,
  ) {
    assistantCoordinatorAttemptIdSchema.parse(input.attemptId);
    return AssistantAttemptContext.parse(
      await this.#client.mutation(
        assistantMutationReference("beginAttempt"),
        input,
      ),
    );
  }

  async recordProgress(
    attemptId: string,
    state: "planning" | "reading" | "finalizing",
  ): Promise<void> {
    assistantCoordinatorAttemptIdSchema.parse(attemptId);
    await this.#client.mutation(assistantMutationReference("recordProgress"), {
      attemptId,
      state,
    });
  }

  async recordEvent(
    input: Readonly<{
      attemptId: string;
      eventId: string;
      event: AssistantAttemptEventInput;
    }>,
  ): Promise<{ sequence: number }> {
    assistantCoordinatorAttemptIdSchema.parse(input.attemptId);
    if (!/^event:[a-zA-Z0-9][a-zA-Z0-9._:-]{0,121}$/.test(input.eventId)) {
      throw new Error("ASSISTANT_EVENT_ID_RESERVED");
    }
    const value = assertResultObject(
      await this.#client.mutation(
        assistantMutationReference("recordEvent"),
        input,
      ),
      "ASSISTANT_BROKER_RESPONSE_INVALID",
    );
    if (
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 1
    ) {
      throw new Error("ASSISTANT_BROKER_RESPONSE_INVALID");
    }
    return { sequence: value.sequence as number };
  }

  async settleClarification(
    attemptId: string,
    question: string,
  ): Promise<void> {
    assistantCoordinatorAttemptIdSchema.parse(attemptId);
    await this.#client.mutation(
      assistantMutationReference("settleClarification"),
      { attemptId, question },
    );
  }

  async settleSuccess(
    attemptId: string,
    value: FinalizerOutputValue,
  ): Promise<void> {
    assistantCoordinatorAttemptIdSchema.parse(attemptId);
    await this.#client.mutation(assistantMutationReference("settleSuccess"), {
      attemptId,
      markdown: value.markdown,
      proposals: value.proposals,
    });
  }

  async settleFailure(
    attemptId: string,
    failure: AssistantFailure,
  ): Promise<void> {
    assistantCoordinatorAttemptIdSchema.parse(attemptId);
    await this.#client.mutation(assistantMutationReference("settleFailure"), {
      attemptId,
      code: failure.code,
      ...(failure.message === undefined ? {} : { message: failure.message }),
    });
  }

  async requestCancellation(attemptId: string): Promise<void> {
    assistantCoordinatorAttemptIdSchema.parse(attemptId);
    await this.#client.mutation(
      assistantMutationReference("requestCancellation"),
      { attemptId },
    );
  }

  async read(input: Parameters<AssistantCalendarReadClient["read"]>[0]) {
    assistantCoordinatorAttemptIdSchema.parse(input.attemptId);
    return await this.#client.query(assistantQueryReference("readCalendar"), {
      attemptId: input.attemptId,
      selectedCalendarIds: [...input.selectedCalendarIds],
      reads: [...input.reads],
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const cleanup of [...this.#subscriptionCleanups]) cleanup();
    await this.#client.close();
  }
}

class AccountScopedCalendarBrokerClient implements CalendarBrokerPort {
  constructor(
    private readonly owner: ConvexCalendarBrokerClient,
    private readonly accountId: string,
  ) {}

  #assertAccount(accountId: string): void {
    if (accountId !== this.accountId) {
      throw new Error("CALENDAR_BROKER_ACCOUNT_MISMATCH");
    }
  }

  subscribePending(listener: () => void): () => void {
    return this.owner.subscribePendingForAccount(this.accountId, listener);
  }

  async listSyncCalendars(accountId: string) {
    this.#assertAccount(accountId);
    return await this.owner.listSyncCalendars(accountId);
  }

  async applyRemoteCalendars(
    accountId: string,
    calendars: readonly GoogleCalendar[],
  ) {
    this.#assertAccount(accountId);
    return await this.owner.applyRemoteCalendars(accountId, calendars);
  }

  async leaseOperations(
    accountId: string,
    leaseId: string,
    options?: Readonly<{ limit?: number; leaseDurationMs?: number }>,
  ) {
    this.#assertAccount(accountId);
    return await this.owner.leaseOperations(accountId, leaseId, options);
  }

  async heartbeatLease(
    ...args: Parameters<CalendarBrokerPort["heartbeatLease"]>
  ) {
    return await this.owner.heartbeatLease(...args);
  }

  async recordRemoteSuccess(
    ...args: Parameters<CalendarBrokerPort["recordRemoteSuccess"]>
  ) {
    return await this.owner.recordRemoteSuccess(...args);
  }

  async recordRemoteAmbiguous(
    ...args: Parameters<CalendarBrokerPort["recordRemoteAmbiguous"]>
  ) {
    return await this.owner.recordRemoteAmbiguous(...args);
  }

  async recordRemoteConflict(
    ...args: Parameters<CalendarBrokerPort["recordRemoteConflict"]>
  ) {
    return await this.owner.recordRemoteConflict(...args);
  }

  async recordRemoteFailure(
    ...args: Parameters<CalendarBrokerPort["recordRemoteFailure"]>
  ) {
    return await this.owner.recordRemoteFailure(...args);
  }

  async recordRemoteRetry(
    ...args: Parameters<CalendarBrokerPort["recordRemoteRetry"]>
  ) {
    return await this.owner.recordRemoteRetry(...args);
  }

  async applyRemotePage(
    ...args: Parameters<CalendarBrokerPort["applyRemotePage"]>
  ) {
    this.#assertAccount(args[0].accountId);
    return await this.owner.applyRemotePage(...args);
  }

  async beginRemoteFullSync(
    ...args: Parameters<CalendarBrokerPort["beginRemoteFullSync"]>
  ) {
    this.#assertAccount(args[0].accountId);
    return await this.owner.beginRemoteFullSync(...args);
  }

  async completeRemoteSync(
    ...args: Parameters<CalendarBrokerPort["completeRemoteSync"]>
  ) {
    this.#assertAccount(args[0].accountId);
    return await this.owner.completeRemoteSync(...args);
  }

  async releaseLease(...args: Parameters<CalendarBrokerPort["releaseLease"]>) {
    return await this.owner.releaseLease(...args);
  }

  async close(): Promise<void> {
    // The owner exclusively controls the shared Convex transport lifetime.
  }
}
