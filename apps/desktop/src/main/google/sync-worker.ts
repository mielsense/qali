import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

import { GoogleCalendarError, isGoogleSyncTokenExpired } from "./errors";
import {
  googleConferenceRequestIdForOperation,
  googleEventIdForOperation,
} from "./mappers";
import {
  backoffDelayMs,
  eventMatchesWrite,
  futureRecurrence,
  googleEventToRemoteSnapshot,
  resolveRecurringTarget,
  snapshotToGoogleWrite,
  trimRecurrenceBefore,
  type RemoteEventReceipt,
  type RemoteEventSnapshot,
} from "./reconcile";
import type {
  GoogleCalendar,
  GoogleDeleteOperation,
  GoogleEvent,
  GoogleEventChanges,
  GoogleEventWrite,
  GoogleInsertOperation,
  GoogleMoveOperation,
  GooglePatchOperation,
  GoogleRespondOperation,
} from "./types";

export type SyncWakeTrigger =
  | "startup"
  | "connection"
  | "local-pending"
  | "online"
  | "manual"
  | "periodic-pull"
  | "retry-deadline";

export function monitorOnlineRestoration(
  options: Readonly<{
    isOnline(): boolean;
    wake(trigger: "online"): void;
    intervalMs?: number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  }>,
): () => void {
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  let wasOnline = options.isOnline();
  const timer = schedule(() => {
    const online = options.isOnline();
    if (!wasOnline && online) options.wake("online");
    wasOnline = online;
  }, options.intervalMs ?? 5_000);
  return () => cancel(timer);
}

async function settleByDeadline(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

export async function shutdownSyncBeforeBackend(
  options: Readonly<{
    sync: Readonly<{ drain(): Promise<void>; stop(): Promise<void> }> | null;
    stopBackend(): Promise<void>;
    timeoutMs?: number;
  }>,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 6_000;
  if (options.sync) {
    await settleByDeadline(options.sync.drain(), timeoutMs);
    await settleByDeadline(options.sync.stop(), timeoutMs);
  }
  await options.stopBackend();
}

export type GoogleSyncStatus =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "pending"; trigger: SyncWakeTrigger }>
  | Readonly<{ kind: "syncing"; trigger: SyncWakeTrigger }>
  | Readonly<{ kind: "conflict"; operationId: string }>
  | Readonly<{ kind: "ambiguous"; operationId: string }>
  | Readonly<{ kind: "authentication-required" }>
  | Readonly<{ kind: "configuration-required" }>
  | Readonly<{ kind: "rate-limit"; retryAt: number }>
  | Readonly<{ kind: "offline"; retryAt: number }>
  | Readonly<{ kind: "failed"; operationId?: string }>
  | Readonly<{ kind: "stopped" }>;

export type CalendarOperationState =
  | "pending"
  | "syncing"
  | "succeeded"
  | "conflict"
  | "ambiguous"
  | "failed"
  | "cancelled";

export type CalendarOperationPayload =
  | Readonly<{ event: RemoteEventSnapshot }>
  | Readonly<{
      patch: Partial<RemoteEventSnapshot> & {
        recurrenceScope?: "thisEvent" | "thisAndFollowing" | "allEvents";
      };
    }>
  | Readonly<{
      destinationCalendarId: string;
      destinationProviderCalendarId: string;
    }>
  | Readonly<{
      responseStatus: "accepted" | "tentative" | "declined";
    }>
  | Readonly<{
      recurrenceScope?: "thisEvent" | "thisAndFollowing" | "allEvents";
    }>;

export type LeasedCalendarOperation = Readonly<{
  operationId: string;
  accountId: string;
  calendarId: string;
  providerCalendarId: string;
  localEventId: string;
  remoteEventId?: string;
  kind: "create" | "update" | "move" | "respond" | "delete";
  payload: CalendarOperationPayload;
  baseRemoteSnapshot?: RemoteEventSnapshot;
  baseRemoteEtag?: string;
  uploadBaseRemoteSnapshot?: RemoteEventSnapshot;
  uploadBaseRemoteEtag?: string;
  state: CalendarOperationState;
  attemptCount: number;
  leaseId: string;
  leasedFromState: CalendarOperationState;
  consumedOperationIds: readonly string[];
  recurrence?: Readonly<{
    recurringEventId: string;
    occurrenceStartMs: number;
  }>;
  createdAt: number;
  updatedAt: number;
}>;

export type SyncCalendar = Readonly<{
  accountId: string;
  calendarId: string;
  providerCalendarId: string;
  syncToken?: string;
}>;

export interface CalendarBrokerPort {
  subscribePending(listener: () => void): () => void;
  listSyncCalendars(accountId: string): Promise<readonly SyncCalendar[]>;
  applyRemoteCalendars(
    accountId: string,
    calendars: readonly GoogleCalendar[],
  ): Promise<void>;
  leaseOperations(
    accountId: string,
    leaseId: string,
    options?: Readonly<{ limit?: number; leaseDurationMs?: number }>,
  ): Promise<readonly LeasedCalendarOperation[]>;
  heartbeatLease(leaseId: string, leaseDurationMs?: number): Promise<unknown>;
  recordRemoteSuccess(
    args: Readonly<{
      operationId: string;
      leaseId: string;
      remoteSnapshot?: RemoteEventSnapshot;
      remoteEtag?: string;
      remoteUpdatedAt?: number;
      remoteReceipt?: string;
    }>,
  ): Promise<unknown>;
  recordRemoteAmbiguous(
    args: Readonly<{
      operationId: string;
      leaseId: string;
      safeError: string;
      retryAt?: number;
    }>,
  ): Promise<unknown>;
  recordRemoteConflict(
    args: Readonly<{
      operationId: string;
      leaseId: string;
      currentRemoteSnapshot: RemoteEventSnapshot;
      remoteEtag?: string;
      remoteUpdatedAt?: number;
      safeError: string;
    }>,
  ): Promise<unknown>;
  recordRemoteFailure(
    args: Readonly<{
      operationId: string;
      leaseId: string;
      safeError: string;
    }>,
  ): Promise<unknown>;
  recordRemoteRetry(
    args: Readonly<{
      operationId: string;
      leaseId: string;
      safeError: string;
      retryAt: number;
    }>,
  ): Promise<unknown>;
  applyRemotePage(
    args: Readonly<{
      accountId: string;
      calendarId: string;
      providerCalendarId: string;
      events: readonly Readonly<{
        remoteSnapshot: RemoteEventSnapshot;
        remoteEtag?: string;
        remoteUpdatedAt?: number;
        deleted?: boolean;
        recurringEventId?: string;
      }>[];
      fullSyncGeneration?: number;
    }>,
  ): Promise<unknown>;
  beginRemoteFullSync(
    args: Readonly<{
      accountId: string;
      calendarId: string;
      providerCalendarId: string;
    }>,
  ): Promise<Readonly<{ generation: number }>>;
  completeRemoteSync(
    args: Readonly<{
      accountId: string;
      calendarId: string;
      providerCalendarId: string;
      syncToken?: string;
      fullSyncGeneration?: number;
    }>,
  ): Promise<Readonly<{ done: boolean; removed: number }>>;
  releaseLease(leaseId: string): Promise<unknown>;
  close?(): Promise<void>;
}

export interface GoogleCalendarPort {
  listCalendars(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<readonly GoogleCalendar[]>;
  listEventChanges(
    accessToken: string,
    options: Readonly<{
      calendarId: string;
      syncToken?: string;
      timeMinMs?: number;
      timeMaxMs?: number;
      signal: AbortSignal;
    }>,
  ): Promise<GoogleEventChanges>;
  getEvent(
    accessToken: string,
    options: Readonly<{
      calendarId: string;
      eventId: string;
      signal: AbortSignal;
    }>,
  ): Promise<GoogleEvent>;
  insertEvent(
    accessToken: string,
    calendarId: string,
    operation: GoogleInsertOperation,
  ): Promise<GoogleEvent>;
  patchEvent(
    accessToken: string,
    operation: GooglePatchOperation,
  ): Promise<GoogleEvent>;
  moveEvent(
    accessToken: string,
    operation: GoogleMoveOperation,
  ): Promise<GoogleEvent>;
  respondToEvent(
    accessToken: string,
    operation: GoogleRespondOperation,
  ): Promise<GoogleEvent>;
  deleteEvent(
    accessToken: string,
    operation: GoogleDeleteOperation,
  ): Promise<void>;
}

export type GoogleOAuthPort = Readonly<{
  accessToken(): Promise<string>;
  status(): Promise<Readonly<{ kind: string }>>;
}>;

export type GoogleSyncWorkerOptions = Readonly<{
  accountId: string;
  broker: CalendarBrokerPort;
  google: GoogleCalendarPort;
  oauth: GoogleOAuthPort;
  now?: () => number;
  random?: () => number;
  fullSyncPastMs?: number;
  fullSyncFutureMs?: number;
  leaseDurationMs?: number;
  leaseLimit?: number;
  heartbeatMs?: number;
  maxConcurrentOperations?: number;
  drainTimeoutMs?: number;
  pullIntervalMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  cycleGate?: Readonly<{
    run<T>(task: () => Promise<T>): Promise<T>;
  }>;
}>;

const DEFAULT_FULL_SYNC_PAST_MS = 366 * 24 * 60 * 60_000;
const DEFAULT_FULL_SYNC_FUTURE_MS = 2 * 366 * 24 * 60 * 60_000;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_PULL_INTERVAL_MS = 60_000;
const MAX_REMOTE_PAGE = 250;
const MAX_FINALIZE_PASSES = 400;

function isTerminalCredentialError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "GOOGLE_OAUTH_NOT_CONNECTED" ||
      error.message === "GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE")
  );
}

function safeError(error: unknown): GoogleCalendarError | undefined {
  return error instanceof GoogleCalendarError ? error : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function recurrenceScope(operation: LeasedCalendarOperation) {
  if ("patch" in operation.payload) {
    return operation.payload.patch.recurrenceScope;
  }
  if ("recurrenceScope" in operation.payload) {
    return operation.payload.recurrenceScope;
  }
  return undefined;
}

function patchWithoutScope(operation: LeasedCalendarOperation) {
  if (!("patch" in operation.payload)) return {};
  const { recurrenceScope: _, ...patch } = operation.payload.patch;
  return patch;
}

function googleWritePatch(
  operation: LeasedCalendarOperation,
): GoogleEventWrite {
  const patch = patchWithoutScope(operation);
  return withoutUndefined({
    summary: patch.summary,
    description: patch.description,
    location: patch.location,
    startMs: patch.startMs,
    endMs: patch.endMs,
    allDay: patch.allDay,
    timeZone: patch.timeZone,
    colorId: patch.colorId,
    visibility: patch.visibility,
    transparency: patch.transparency,
    attendees: patch.attendees,
    recurrence: patch.recurrence,
    conference:
      patch.conference === null
        ? "remove"
        : patch.conference?.requestId
          ? "add"
          : undefined,
  });
}

function receiptText(
  operation: LeasedCalendarOperation,
  suffix: string,
): string {
  return `${operation.operationId}:${suffix}`.slice(0, 2_048);
}

export class GoogleSyncWorker {
  readonly #accountId: string;
  readonly #broker: CalendarBrokerPort;
  readonly #clearTimer: typeof clearTimeout;
  readonly #cycleGate: NonNullable<GoogleSyncWorkerOptions["cycleGate"]>;
  readonly #events = new EventEmitter();
  readonly #drainTimeoutMs: number;
  readonly #fullSyncFutureMs: number;
  readonly #fullSyncPastMs: number;
  readonly #google: GoogleCalendarPort;
  readonly #heartbeatMs: number;
  readonly #leaseDurationMs: number;
  readonly #leaseLimit: number;
  readonly #maxConcurrentOperations: number;
  readonly #now: () => number;
  readonly #oauth: GoogleOAuthPort;
  readonly #pullIntervalMs: number;
  readonly #random: () => number;
  readonly #setTimer: typeof setTimeout;
  #abortController = new AbortController();
  #activeLeaseIds = new Set<string>();
  #authPaused = false;
  #draining = false;
  #heartbeatTimers = new Set<ReturnType<typeof setTimeout>>();
  #pullFailureCount = 0;
  #lastStatus: GoogleSyncStatus = { kind: "idle" };
  #pendingTrigger: SyncWakeTrigger | null = null;
  #runPromise: Promise<void> | null = null;
  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribePending: (() => void) | null = null;

  constructor(options: GoogleSyncWorkerOptions) {
    this.#accountId = options.accountId;
    this.#broker = options.broker;
    this.#google = options.google;
    this.#oauth = options.oauth;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#fullSyncPastMs = options.fullSyncPastMs ?? DEFAULT_FULL_SYNC_PAST_MS;
    this.#fullSyncFutureMs =
      options.fullSyncFutureMs ?? DEFAULT_FULL_SYNC_FUTURE_MS;
    this.#leaseDurationMs =
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#leaseLimit = options.leaseLimit ?? 10;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#maxConcurrentOperations = options.maxConcurrentOperations ?? 4;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.#pullIntervalMs = options.pullIntervalMs ?? DEFAULT_PULL_INTERVAL_MS;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#cycleGate =
      options.cycleGate ??
      ({ run: async <T>(task: () => Promise<T>) => await task() } as const);
    if (
      !this.#accountId ||
      this.#leaseDurationMs < 5_000 ||
      this.#heartbeatMs < 100 ||
      this.#heartbeatMs >= this.#leaseDurationMs ||
      this.#leaseLimit < 1 ||
      this.#leaseLimit > 25 ||
      this.#maxConcurrentOperations < 1 ||
      this.#maxConcurrentOperations > 8 ||
      this.#drainTimeoutMs < 1 ||
      this.#drainTimeoutMs > 30_000 ||
      this.#pullIntervalMs < 1
    ) {
      throw new Error("GOOGLE_SYNC_CONFIGURATION_INVALID");
    }
  }

  get status(): GoogleSyncStatus {
    return this.#lastStatus;
  }

  onStatus(listener: (status: GoogleSyncStatus) => void): () => void {
    this.#events.on("status", listener);
    return () => this.#events.off("status", listener);
  }

  #emit(status: GoogleSyncStatus): void {
    this.#lastStatus = status;
    this.#events.emit("status", status);
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#subscribePending();
    this.wake("startup");
  }

  #subscribePending(): void {
    if (this.#unsubscribePending !== null) return;
    this.#unsubscribePending = this.#broker.subscribePending(() => {
      this.wake("local-pending");
    });
  }

  wake(trigger: SyncWakeTrigger): void {
    if (this.#stopped) return;
    if (this.#draining && trigger !== "connection") return;
    if (trigger === "connection") {
      this.#authPaused = false;
      this.#draining = false;
      if (this.#started) this.#subscribePending();
    }
    this.#pendingTrigger = trigger;
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#emit({ kind: "pending", trigger });
    this.#ensureLoop();
  }

  #ensureLoop(): void {
    if (this.#runPromise !== null || this.#pendingTrigger === null) return;
    const run = this.#runLoop()
      .catch((error) => this.#recoverFromLoopFailure(error))
      .finally(() => {
        if (this.#runPromise === run) this.#runPromise = null;
        if (
          this.#pendingTrigger !== null &&
          !this.#stopped &&
          !this.#draining
        ) {
          this.#ensureLoop();
        }
      });
    this.#runPromise = run;
  }

  #recoverFromLoopFailure(_error: unknown): void {
    if (this.#stopped || this.#draining || this.#authPaused) return;
    this.#pullFailureCount += 1;
    const retryAt =
      this.#now() +
      backoffDelayMs(this.#pullFailureCount, undefined, this.#random);
    this.#emit({ kind: "offline", retryAt });
    this.#scheduleRetry(retryAt);
  }

  async #runLoop(): Promise<void> {
    while (this.#pendingTrigger !== null && !this.#stopped && !this.#draining) {
      const trigger = this.#pendingTrigger;
      this.#pendingTrigger = null;
      this.#emit({ kind: "syncing", trigger });
      await this.#cycleGate.run(async () => await this.runOnce());
    }
    if (!this.#stopped && !this.#draining && !this.#authPaused) {
      this.#emit({ kind: "idle" });
    }
  }

  async drain(): Promise<void> {
    if (this.#stopped) return;
    // Start the already-accepted wake before closing the gate to new wakeups.
    this.#ensureLoop();
    this.#draining = true;
    this.#pendingTrigger = null;
    this.#unsubscribePending?.();
    this.#unsubscribePending = null;
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#clearHeartbeatTimers();
    const run = this.#runPromise;
    if (run && !(await this.#waitBounded(run))) {
      this.#abortController.abort();
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    if (!this.#draining) await this.drain();
    this.#stopped = true;
    this.#abortController.abort();
    void this.#runPromise?.catch(() => {});
    await this.#waitBounded(
      Promise.allSettled(
        [...this.#activeLeaseIds].map((leaseId) =>
          this.#broker.releaseLease(leaseId),
        ),
      ),
    );
    this.#activeLeaseIds.clear();
    if (this.#broker.close) await this.#waitBounded(this.#broker.close());
    this.#emit({ kind: "stopped" });
  }

  async #waitBounded(promise: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#drainTimeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return completed;
  }

  async runOnce(): Promise<void> {
    if (this.#stopped || this.#draining || this.#authPaused) return;
    const connected = await this.#oauth.status().catch(() => ({
      kind: "unavailable",
    }));
    if (this.#stopped || this.#draining) return;
    if (connected.kind !== "connected") {
      this.#authPaused = true;
      this.#emit({ kind: "authentication-required" });
      return;
    }
    let accessToken: string;
    try {
      accessToken = await this.#oauth.accessToken();
    } catch (error) {
      if (isTerminalCredentialError(error)) {
        this.#authPaused = true;
        this.#emit({ kind: "authentication-required" });
      } else {
        this.#recoverFromLoopFailure(error);
      }
      return;
    }
    if (this.#stopped || this.#draining) return;
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    try {
      const remoteCalendars = await this.#google.listCalendars(
        accessToken,
        signal,
      );
      await this.#broker.applyRemoteCalendars(this.#accountId, remoteCalendars);
      if (this.#stopped || this.#draining || signal.aborted) return;
      const calendars = await this.#broker.listSyncCalendars(this.#accountId);
      this.#assertCalendarAccounts(calendars);
      for (const calendar of calendars) {
        if (signal.aborted) break;
        await this.#pullWithToken(accessToken, calendar, signal);
      }
      this.#pullFailureCount = 0;
    } catch (error) {
      const typed = safeError(error);
      if (typed?.kind === "auth") {
        this.#authPaused = true;
        this.#emit({ kind: "authentication-required" });
        return;
      }
      if (typed?.code === "api-not-configured") {
        this.#emit({ kind: "configuration-required" });
        return;
      }
      this.#pullFailureCount += 1;
      const retryAt =
        this.#now() +
        backoffDelayMs(
          this.#pullFailureCount,
          typed?.retryAfterMs,
          this.#random,
        );
      this.#emit({
        kind: typed?.kind === "rate-limit" ? "rate-limit" : "offline",
        retryAt,
      });
      this.#scheduleRetry(retryAt);
      return;
    }

    if (signal.aborted || this.#authPaused) return;
    if (this.#stopped || this.#draining) return;
    await this.#upload(accessToken, signal);
    if (!this.#stopped && !this.#draining && !this.#authPaused) {
      this.#schedulePeriodicPull();
    }
  }

  async pull(calendarId: string): Promise<void> {
    if (this.#stopped || this.#draining) return;
    const accessToken = await this.#oauth.accessToken();
    this.#abortController = new AbortController();
    const calendars = await this.#broker.listSyncCalendars(this.#accountId);
    this.#assertCalendarAccounts(calendars);
    const calendar = calendars.find((entry) => entry.calendarId === calendarId);
    if (!calendar) throw new Error("GOOGLE_SYNC_CALENDAR_NOT_FOUND");
    await this.#pullWithToken(
      accessToken,
      calendar,
      this.#abortController.signal,
    );
  }

  async #pullWithToken(
    accessToken: string,
    calendar: SyncCalendar,
    signal: AbortSignal,
  ): Promise<void> {
    let changes: GoogleEventChanges;
    let generation: number | undefined;
    if (calendar.syncToken === undefined) {
      generation = (
        await this.#broker.beginRemoteFullSync({
          accountId: calendar.accountId,
          calendarId: calendar.calendarId,
          providerCalendarId: calendar.providerCalendarId,
        })
      ).generation;
    }
    try {
      changes = await this.#google.listEventChanges(accessToken, {
        calendarId: calendar.providerCalendarId,
        ...(calendar.syncToken
          ? { syncToken: calendar.syncToken }
          : {
              timeMinMs: this.#now() - this.#fullSyncPastMs,
              timeMaxMs: this.#now() + this.#fullSyncFutureMs,
            }),
        signal,
      });
    } catch (error) {
      if (!isGoogleSyncTokenExpired(error)) throw error;
      const full = await this.#broker.beginRemoteFullSync({
        accountId: calendar.accountId,
        calendarId: calendar.calendarId,
        providerCalendarId: calendar.providerCalendarId,
      });
      generation = full.generation;
      changes = await this.#google.listEventChanges(accessToken, {
        calendarId: calendar.providerCalendarId,
        timeMinMs: this.#now() - this.#fullSyncPastMs,
        timeMaxMs: this.#now() + this.#fullSyncFutureMs,
        signal,
      });
    }
    const mapped = changes.events.map((event) =>
      this.#mapPulledEvent(event, calendar),
    );
    for (let index = 0; index < mapped.length; index += MAX_REMOTE_PAGE) {
      await this.#broker.applyRemotePage({
        accountId: calendar.accountId,
        calendarId: calendar.calendarId,
        providerCalendarId: calendar.providerCalendarId,
        events: mapped.slice(index, index + MAX_REMOTE_PAGE),
        ...(generation === undefined ? {} : { fullSyncGeneration: generation }),
      });
    }
    if (mapped.length === 0 && generation !== undefined) {
      await this.#broker.applyRemotePage({
        accountId: calendar.accountId,
        calendarId: calendar.calendarId,
        providerCalendarId: calendar.providerCalendarId,
        events: [],
        fullSyncGeneration: generation,
      });
    }
    for (let pass = 0; pass < MAX_FINALIZE_PASSES; pass += 1) {
      const result = await this.#broker.completeRemoteSync({
        accountId: calendar.accountId,
        calendarId: calendar.calendarId,
        providerCalendarId: calendar.providerCalendarId,
        ...(changes.nextSyncToken ? { syncToken: changes.nextSyncToken } : {}),
        ...(generation === undefined ? {} : { fullSyncGeneration: generation }),
      });
      if (result.done) return;
    }
    throw new Error("GOOGLE_FULL_SYNC_FINALIZE_LIMIT");
  }

  #mapPulledEvent(
    event: GoogleEvent,
    calendar: SyncCalendar,
  ): {
    remoteSnapshot: RemoteEventSnapshot;
    remoteEtag?: string;
    remoteUpdatedAt?: number;
    deleted?: boolean;
    recurringEventId?: string;
  } {
    if (
      event.status === "cancelled" &&
      (event.startMs === undefined ||
        event.endMs === undefined ||
        event.allDay === undefined)
    ) {
      return withoutUndefined({
        remoteSnapshot: {
          localEventId: "",
          accountId: calendar.accountId,
          calendarId: calendar.calendarId,
          providerCalendarId: calendar.providerCalendarId,
          remoteEventId: event.id,
          startMs: 0,
          endMs: 1,
          allDay: false,
          status: "cancelled",
        },
        remoteEtag: event.etag,
        remoteUpdatedAt: event.updatedMs,
        deleted: true,
        recurringEventId: event.recurringEventId,
      });
    }
    const receipt = googleEventToRemoteSnapshot(event, {
      accountId: calendar.accountId,
      calendarId: calendar.calendarId,
      providerCalendarId: calendar.providerCalendarId,
      localEventId: "",
    });
    return withoutUndefined({
      ...receipt,
      deleted: event.status === "cancelled" ? true : undefined,
      recurringEventId: event.recurringEventId,
    });
  }

  async #upload(accessToken: string, signal: AbortSignal): Promise<void> {
    const leaseId = `lease_${randomBytes(16).toString("base64url")}`;
    const operations = await this.#broker.leaseOperations(
      this.#accountId,
      leaseId,
      {
        limit: this.#leaseLimit,
        leaseDurationMs: this.#leaseDurationMs,
      },
    );
    this.#assertOperationAccounts(operations);
    if (operations.length === 0) return;
    this.#activeLeaseIds.add(leaseId);
    let heartbeat: ReturnType<typeof setTimeout> | null = null;
    let heartbeatStopped = false;
    const scheduleHeartbeat = () => {
      const timer = this.#setTimer(() => {
        this.#heartbeatTimers.delete(timer);
        void beat();
      }, this.#heartbeatMs);
      heartbeat = timer;
      this.#heartbeatTimers.add(timer);
    };
    const beat = async () => {
      try {
        await this.#broker.heartbeatLease(leaseId, this.#leaseDurationMs);
      } catch {
        this.#abortController.abort();
      } finally {
        if (
          !heartbeatStopped &&
          !this.#draining &&
          !this.#stopped &&
          this.#activeLeaseIds.has(leaseId)
        ) {
          scheduleHeartbeat();
        }
      }
    };
    scheduleHeartbeat();
    try {
      if (signal.aborted || this.#stopped || this.#draining) return;
      for (
        let index = 0;
        index < operations.length;
        index += this.#maxConcurrentOperations
      ) {
        if (signal.aborted || this.#stopped || this.#draining) break;
        const page = operations.slice(
          index,
          index + this.#maxConcurrentOperations,
        );
        // A receipt failure for one operation must not release the shared lease
        // while sibling Google writes are still in flight.
        await Promise.allSettled(
          page.map((operation) =>
            this.#processOperation(accessToken, operation, signal),
          ),
        );
      }
    } finally {
      heartbeatStopped = true;
      if (heartbeat !== null) {
        this.#clearTimer(heartbeat);
        this.#heartbeatTimers.delete(heartbeat);
      }
      await this.#broker.releaseLease(leaseId).catch(() => {});
      this.#activeLeaseIds.delete(leaseId);
    }
  }

  #assertCalendarAccounts(calendars: readonly SyncCalendar[]): void {
    if (calendars.some((calendar) => calendar.accountId !== this.#accountId)) {
      throw new Error("GOOGLE_SYNC_ACCOUNT_MISMATCH");
    }
  }

  #assertOperationAccounts(
    operations: readonly LeasedCalendarOperation[],
  ): void {
    if (
      operations.some((operation) => operation.accountId !== this.#accountId)
    ) {
      throw new Error("GOOGLE_SYNC_ACCOUNT_MISMATCH");
    }
  }

  async #processOperation(
    accessToken: string,
    operation: LeasedCalendarOperation,
    signal: AbortSignal,
  ): Promise<void> {
    if (operation.leasedFromState === "ambiguous") {
      try {
        const reconciled = await this.#reconcileAmbiguous(
          accessToken,
          operation,
          signal,
        );
        if (reconciled) return;
      } catch (error) {
        // Adapter failures are remote outcomes. Untyped failures here come
        // from durable receipt persistence and must leave the lease ambiguous.
        if (!safeError(error)) throw error;
        await this.#handleOperationError(accessToken, operation, signal, error);
        return;
      }
    }
    let receipt: RemoteEventReceipt | undefined;
    try {
      receipt = await this.#executeWrite(accessToken, operation, signal);
    } catch (error) {
      await this.#handleOperationError(accessToken, operation, signal, error);
      return;
    }
    // Do not classify Convex receipt persistence errors as Google failures.
    // Let the shared lease release/expire into durable ambiguity instead.
    await this.#recordSuccess(operation, receipt, "write");
  }

  async #handleOperationError(
    accessToken: string,
    operation: LeasedCalendarOperation,
    signal: AbortSignal,
    error: unknown,
  ): Promise<void> {
    const typed = safeError(error);
    if (!typed) {
      await this.#broker.recordRemoteFailure({
        operationId: operation.operationId,
        leaseId: operation.leaseId,
        safeError: "malformed-response",
      });
      this.#emit({ kind: "failed", operationId: operation.operationId });
      return;
    }
    if (typed.kind === "ambiguous") {
      const reconciled = await this.#reconcileAmbiguous(
        accessToken,
        operation,
        signal,
      ).catch(() => false);
      if (reconciled) return;
      const retryAt =
        this.#now() +
        backoffDelayMs(
          operation.attemptCount,
          typed.retryAfterMs,
          this.#random,
        );
      await this.#broker.recordRemoteAmbiguous({
        operationId: operation.operationId,
        leaseId: operation.leaseId,
        safeError: "ambiguous",
        retryAt,
      });
      this.#emit({ kind: "ambiguous", operationId: operation.operationId });
      this.#scheduleRetry(retryAt);
      return;
    }
    if (typed.kind === "conflict") {
      if (
        operation.kind === "create" ||
        (operation.kind === "update" &&
          recurrenceScope(operation) === "thisAndFollowing")
      ) {
        const reconciled = await this.#reconcileAmbiguous(
          accessToken,
          operation,
          signal,
        ).catch(() => false);
        if (reconciled) return;
      }
      await this.#recordCurrentConflict(accessToken, operation, signal);
      return;
    }
    if (
      typed.kind === "validation" ||
      (typed.kind === "remote" &&
        typed.code === "not-found" &&
        operation.kind !== "delete")
    ) {
      await this.#broker.recordRemoteFailure({
        operationId: operation.operationId,
        leaseId: operation.leaseId,
        safeError: typed.code === "not-found" ? "not-found" : "validation",
      });
      this.#emit({ kind: "failed", operationId: operation.operationId });
      return;
    }
    if (
      typed.kind === "remote" &&
      typed.code === "not-found" &&
      operation.kind === "delete"
    ) {
      await this.#recordSuccess(operation, undefined, "already-deleted");
      return;
    }
    const retryAt =
      this.#now() +
      backoffDelayMs(operation.attemptCount, typed.retryAfterMs, this.#random);
    await this.#broker.recordRemoteRetry({
      operationId: operation.operationId,
      leaseId: operation.leaseId,
      safeError:
        typed.kind === "rate-limit"
          ? "rate-limit"
          : typed.kind === "auth"
            ? "auth"
            : "offline",
      retryAt,
    });
    if (typed.kind === "auth") {
      this.#authPaused = true;
      this.#emit({ kind: "authentication-required" });
    } else if (typed.kind === "rate-limit") {
      this.#emit({ kind: "rate-limit", retryAt });
      this.#scheduleRetry(retryAt);
    } else {
      this.#emit({ kind: "offline", retryAt });
      this.#scheduleRetry(retryAt);
    }
  }

  async #executeWrite(
    accessToken: string,
    operation: LeasedCalendarOperation,
    signal: AbortSignal,
  ): Promise<RemoteEventReceipt | undefined> {
    if (operation.kind === "create") {
      if (!("event" in operation.payload)) {
        throw new Error("GOOGLE_CREATE_PAYLOAD_INVALID");
      }
      const event = operation.payload.event;
      const result = await this.#google.insertEvent(
        accessToken,
        operation.providerCalendarId,
        {
          id: operation.operationId,
          googleEventId: googleEventIdForOperation(operation.operationId),
          conferenceRequestId: googleConferenceRequestIdForOperation(
            operation.operationId,
          ),
          event: snapshotToGoogleWrite(event),
          signal,
        },
      );
      return googleEventToRemoteSnapshot(result, operation);
    }
    if (!operation.remoteEventId || !operation.uploadBaseRemoteEtag) {
      throw new Error("GOOGLE_WRITE_PRECONDITION_MISSING");
    }
    const target = resolveRecurringTarget({
      calendarId: operation.providerCalendarId,
      eventId: operation.remoteEventId,
      recurringEventId: operation.recurrence?.recurringEventId,
      occurrenceStartMs: operation.recurrence?.occurrenceStartMs,
      scope: recurrenceScope(operation),
    });
    if (target.kind === "split") {
      return await this.#executeSeriesSplit(
        accessToken,
        operation,
        target,
        signal,
      );
    }
    let targetEtag = operation.uploadBaseRemoteEtag;
    if (target.target.eventId !== operation.remoteEventId) {
      const master = await this.#google.getEvent(accessToken, {
        ...target.target,
        signal,
      });
      if (!master.etag) throw new Error("GOOGLE_WRITE_PRECONDITION_MISSING");
      targetEtag = master.etag;
    }
    if (operation.kind === "update") {
      const result = await this.#google.patchEvent(accessToken, {
        id: operation.operationId,
        ...target.target,
        etag: targetEtag,
        patch: googleWritePatch(operation),
        conferenceRequestId: googleConferenceRequestIdForOperation(
          operation.operationId,
        ),
        signal,
      });
      return this.#receiptForScopedResult(result, operation);
    }
    if (operation.kind === "move") {
      if (!("destinationProviderCalendarId" in operation.payload)) {
        throw new Error("GOOGLE_MOVE_PAYLOAD_INVALID");
      }
      const result = await this.#google.moveEvent(accessToken, {
        id: operation.operationId,
        ...target.target,
        etag: targetEtag,
        destinationCalendarId: operation.payload.destinationProviderCalendarId,
        signal,
      });
      return googleEventToRemoteSnapshot(result, {
        ...operation,
        calendarId: operation.payload.destinationCalendarId,
        providerCalendarId: operation.payload.destinationProviderCalendarId,
      });
    }
    if (operation.kind === "respond") {
      if (!("responseStatus" in operation.payload)) {
        throw new Error("GOOGLE_RESPONSE_PAYLOAD_INVALID");
      }
      const result = await this.#google.respondToEvent(accessToken, {
        id: operation.operationId,
        ...target.target,
        etag: targetEtag,
        responseStatus: operation.payload.responseStatus,
        signal,
      });
      return this.#receiptForScopedResult(result, operation);
    }
    await this.#google.deleteEvent(accessToken, {
      id: operation.operationId,
      ...target.target,
      etag: targetEtag,
      signal,
    });
    return undefined;
  }

  #receiptForScopedResult(
    result: GoogleEvent,
    operation: LeasedCalendarOperation,
  ): RemoteEventReceipt {
    if (result.id === operation.remoteEventId) {
      return googleEventToRemoteSnapshot(result, operation);
    }
    const base =
      operation.uploadBaseRemoteSnapshot ?? operation.baseRemoteSnapshot;
    if (!base || operation.kind !== "update") {
      return googleEventToRemoteSnapshot(result, operation);
    }
    const desired = {
      ...base,
      ...patchWithoutScope(operation),
    } as RemoteEventSnapshot;
    return {
      remoteSnapshot: desired,
      remoteUpdatedAt: result.updatedMs,
    };
  }

  async #executeSeriesSplit(
    accessToken: string,
    operation: LeasedCalendarOperation,
    target: Extract<
      ReturnType<typeof resolveRecurringTarget>,
      { kind: "split" }
    >,
    signal: AbortSignal,
  ): Promise<RemoteEventReceipt | undefined> {
    const master = await this.#google.getEvent(accessToken, {
      ...target.master,
      signal,
    });
    if (
      !master.etag ||
      !master.recurrence ||
      master.startMs === undefined ||
      master.endMs === undefined ||
      master.allDay === undefined
    ) {
      throw new Error("GOOGLE_RECURRENCE_MASTER_INVALID");
    }
    await this.#google.patchEvent(accessToken, {
      id: operation.operationId,
      ...target.master,
      etag: master.etag,
      patch: {
        recurrence: trimRecurrenceBefore(master.recurrence, target.splitAtMs),
      },
      signal,
    });
    if (operation.kind === "delete") return undefined;
    if (operation.kind !== "update") {
      throw new Error("GOOGLE_RECURRENCE_SCOPE_UNSUPPORTED");
    }
    const base =
      operation.uploadBaseRemoteSnapshot ?? operation.baseRemoteSnapshot;
    if (!base) throw new Error("GOOGLE_RECURRENCE_BASELINE_REQUIRED");
    const patch = patchWithoutScope(operation);
    const futureStart = patch.startMs ?? target.splitAtMs;
    const desired = {
      ...base,
      ...patch,
      startMs: futureStart,
      endMs: patch.endMs ?? futureStart + (base.endMs - base.startMs),
      recurrence: futureRecurrence(
        (patch.recurrence as string[] | undefined) ?? master.recurrence,
      ),
    } as RemoteEventSnapshot;
    let result: GoogleEvent;
    try {
      result = await this.#google.insertEvent(
        accessToken,
        operation.providerCalendarId,
        {
          id: operation.operationId,
          googleEventId: googleEventIdForOperation(operation.operationId),
          conferenceRequestId: googleConferenceRequestIdForOperation(
            operation.operationId,
          ),
          event: snapshotToGoogleWrite(desired),
          signal,
        },
      );
    } catch {
      // The master trim is already durable remotely. Keep the compound outcome
      // ambiguous so recovery reconciles the deterministic future-series ID.
      throw new GoogleCalendarError("ambiguous", "write-outcome-unknown", {
        operationId: operation.operationId,
      });
    }
    return {
      remoteSnapshot: desired,
      remoteUpdatedAt: result.updatedMs,
    };
  }

  async #reconcileAmbiguous(
    accessToken: string,
    operation: LeasedCalendarOperation,
    signal: AbortSignal,
  ): Promise<boolean> {
    const scopedRecurrence = recurrenceScope(operation);
    const targetId =
      operation.kind === "create" ||
      (operation.kind === "update" && scopedRecurrence === "thisAndFollowing")
        ? googleEventIdForOperation(operation.operationId)
        : scopedRecurrence === "allEvents" && operation.recurrence
          ? operation.recurrence.recurringEventId
          : operation.remoteEventId;
    if (!targetId) return false;
    let current: GoogleEvent;
    try {
      current = await this.#google.getEvent(accessToken, {
        calendarId: operation.providerCalendarId,
        eventId: targetId,
        signal,
      });
    } catch (error) {
      const typed = safeError(error);
      if (typed?.code !== "not-found") throw error;
      if (operation.kind === "delete") {
        await this.#recordSuccess(operation, undefined, "reconciled-delete");
        return true;
      }
      if (
        operation.kind === "move" &&
        "destinationProviderCalendarId" in operation.payload
      ) {
        try {
          const moved = await this.#google.getEvent(accessToken, {
            calendarId: operation.payload.destinationProviderCalendarId,
            eventId: operation.remoteEventId!,
            signal,
          });
          await this.#recordSuccess(
            operation,
            googleEventToRemoteSnapshot(moved, {
              ...operation,
              calendarId: operation.payload.destinationCalendarId,
              providerCalendarId:
                operation.payload.destinationProviderCalendarId,
            }),
            "reconciled-move",
          );
          return true;
        } catch (destinationError) {
          if (safeError(destinationError)?.code !== "not-found") {
            throw destinationError;
          }
        }
      }
      // A durable prior ambiguous state plus a confirmed absence is the only
      // path that permits another deterministic write attempt.
      return false;
    }
    if (
      operation.kind === "create" ||
      (operation.kind === "update" && scopedRecurrence === "thisAndFollowing")
    ) {
      if (
        current.extendedProperties?.private?.qaliOperationId ===
        operation.operationId
      ) {
        const receipt =
          operation.kind === "create"
            ? googleEventToRemoteSnapshot(current, operation)
            : this.#receiptForScopedResult(current, operation);
        await this.#recordSuccess(operation, receipt, "reconciled-create");
        return true;
      }
      await this.#recordConflict(operation, current, "identity-conflict");
      return true;
    }
    if (operation.kind === "update") {
      const write = googleWritePatch(operation);
      if (
        eventMatchesWrite(
          current,
          write,
          write.conference === "add"
            ? googleConferenceRequestIdForOperation(operation.operationId)
            : undefined,
        )
      ) {
        await this.#recordSuccess(
          operation,
          this.#receiptForScopedResult(current, operation),
          "reconciled-update",
        );
        return true;
      }
    }
    const intendedResponse =
      "responseStatus" in operation.payload
        ? operation.payload.responseStatus
        : undefined;
    if (
      operation.kind === "respond" &&
      intendedResponse !== undefined &&
      current.attendees?.some(
        (attendee) =>
          attendee.self === true &&
          attendee.responseStatus === intendedResponse,
      )
    ) {
      await this.#recordSuccess(
        operation,
        this.#receiptForScopedResult(current, operation),
        "reconciled-response",
      );
      return true;
    }
    const baseEtag = operation.uploadBaseRemoteEtag ?? operation.baseRemoteEtag;
    if (
      current.etag !== undefined &&
      baseEtag !== undefined &&
      current.etag !== baseEtag
    ) {
      await this.#recordConflict(operation, current, "remote-conflict");
      return true;
    }
    return false;
  }

  async #recordCurrentConflict(
    accessToken: string,
    operation: LeasedCalendarOperation,
    signal: AbortSignal,
  ): Promise<void> {
    if (!operation.remoteEventId) {
      await this.#broker.recordRemoteFailure({
        operationId: operation.operationId,
        leaseId: operation.leaseId,
        safeError: "conflict",
      });
      return;
    }
    try {
      const current = await this.#google.getEvent(accessToken, {
        calendarId: operation.providerCalendarId,
        eventId: operation.remoteEventId,
        signal,
      });
      await this.#recordConflict(operation, current, "remote-conflict");
    } catch (error) {
      const typed = safeError(error);
      if (typed?.code === "not-found") {
        await this.#broker.recordRemoteFailure({
          operationId: operation.operationId,
          leaseId: operation.leaseId,
          safeError: "not-found",
        });
        return;
      }
      throw error;
    }
  }

  async #recordConflict(
    operation: LeasedCalendarOperation,
    current: GoogleEvent,
    safeErrorCode: string,
  ): Promise<void> {
    const receipt = googleEventToRemoteSnapshot(current, operation);
    await this.#broker.recordRemoteConflict({
      operationId: operation.operationId,
      leaseId: operation.leaseId,
      currentRemoteSnapshot: receipt.remoteSnapshot,
      remoteEtag: receipt.remoteEtag,
      remoteUpdatedAt: receipt.remoteUpdatedAt,
      safeError: safeErrorCode,
    });
    this.#emit({ kind: "conflict", operationId: operation.operationId });
  }

  async #recordSuccess(
    operation: LeasedCalendarOperation,
    receipt: RemoteEventReceipt | undefined,
    suffix: string,
  ): Promise<void> {
    await this.#broker.recordRemoteSuccess(
      withoutUndefined({
        operationId: operation.operationId,
        leaseId: operation.leaseId,
        remoteSnapshot: receipt?.remoteSnapshot,
        remoteEtag: receipt?.remoteEtag,
        remoteUpdatedAt: receipt?.remoteUpdatedAt,
        remoteReceipt: receiptText(operation, suffix),
      }),
    );
  }

  #scheduleRetry(retryAt: number): void {
    if (this.#stopped || this.#draining || this.#authPaused) return;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    const delay = Math.max(0, retryAt - this.#now());
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.wake("retry-deadline");
    }, delay);
  }

  #clearHeartbeatTimers(): void {
    for (const timer of this.#heartbeatTimers) this.#clearTimer(timer);
    this.#heartbeatTimers.clear();
  }

  #schedulePeriodicPull(): void {
    if (!this.#started || this.#stopped || this.#draining || this.#authPaused) {
      return;
    }
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      this.wake("periodic-pull");
    }, this.#pullIntervalMs);
  }
}
