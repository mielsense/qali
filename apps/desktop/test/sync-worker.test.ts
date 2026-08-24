import { describe, expect, test } from "bun:test";

import { GoogleCalendarError } from "../src/main/google/errors";
import { googleConferenceRequestIdForOperation } from "../src/main/google/mappers";
import {
  GoogleSyncWorker,
  monitorOnlineRestoration,
  shutdownSyncBeforeBackend,
  type CalendarBrokerPort,
  type GoogleCalendarPort,
  type LeasedCalendarOperation,
} from "../src/main/google/sync-worker";

const ACCOUNT = "account-1";
const CALENDAR = "gcal_local-primary";
const PROVIDER_CALENDAR = "primary";
const DESTINATION_CALENDAR = "gcal_local-destination";
const DESTINATION_PROVIDER_CALENDAR = "team@example.com";
const START = Date.parse("2026-08-18T09:00:00Z");

function operation(
  overrides: Partial<LeasedCalendarOperation> = {},
): LeasedCalendarOperation {
  return {
    operationId: "operation_00000001",
    accountId: ACCOUNT,
    calendarId: CALENDAR,
    providerCalendarId: PROVIDER_CALENDAR,
    localEventId: "local-1",
    kind: "create",
    payload: {
      event: {
        localEventId: "local-1",
        accountId: ACCOUNT,
        calendarId: CALENDAR,
        summary: "Planning",
        startMs: START,
        endMs: START + 30 * 60_000,
        allDay: false,
        status: "confirmed",
      },
    },
    state: "syncing",
    attemptCount: 1,
    leaseId: "lease-1",
    leasedFromState: "pending",
    consumedOperationIds: ["operation_00000001"],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

class MemoryBroker implements CalendarBrokerPort {
  readonly calls: Array<{ name: string; args: unknown }> = [];
  readonly operations: LeasedCalendarOperation[] = [];
  readonly calendars = [
    {
      accountId: ACCOUNT,
      calendarId: CALENDAR,
      providerCalendarId: PROVIDER_CALENDAR,
      syncToken: "sync-old",
    },
  ];
  status = new Map<string, string>();
  subscribeCount = 0;
  unsubscribeCount = 0;
  readonly leaseStarted: Promise<void>;
  private resolveLeaseStarted!: () => void;
  private wakeListener: (() => void) | undefined;

  constructor() {
    this.leaseStarted = new Promise<void>((resolve) => {
      this.resolveLeaseStarted = resolve;
    });
  }

  subscribePending(listener: () => void): () => void {
    this.subscribeCount += 1;
    this.wakeListener = listener;
    return () => {
      this.unsubscribeCount += 1;
      if (this.wakeListener === listener) this.wakeListener = undefined;
    };
  }

  signalPending(): void {
    this.wakeListener?.();
  }

  async listSyncCalendars() {
    return this.calendars;
  }

  async applyRemoteCalendars(_accountId: string, _calendars: unknown[]) {}

  async leaseOperations(_accountId: string, leaseId: string) {
    this.resolveLeaseStarted();
    const leased = this.operations.splice(0);
    return leased.map((entry) => ({ ...entry, leaseId }));
  }

  async heartbeatLease(leaseId: string) {
    this.calls.push({ name: "heartbeat", args: leaseId });
  }

  async recordRemoteSuccess(args: any) {
    this.calls.push({ name: "success", args });
    this.status.set(args.operationId, "succeeded");
  }

  async recordRemoteAmbiguous(args: any) {
    this.calls.push({ name: "ambiguous", args });
    this.status.set(args.operationId, "ambiguous");
  }

  async recordRemoteConflict(args: any) {
    this.calls.push({ name: "conflict", args });
    this.status.set(args.operationId, "conflict");
  }

  async recordRemoteFailure(args: any) {
    this.calls.push({ name: "failure", args });
    this.status.set(args.operationId, "failed");
  }

  async recordRemoteRetry(args: any) {
    this.calls.push({ name: "retry", args });
    this.status.set(args.operationId, "pending");
  }

  async applyRemotePage(args: any) {
    this.calls.push({ name: "page", args });
  }

  async beginRemoteFullSync(args: any) {
    this.calls.push({ name: "begin-full", args });
    return { generation: 7 };
  }

  async completeRemoteSync(args: any) {
    this.calls.push({ name: "complete-sync", args });
    return { done: true, removed: 0 };
  }

  async releaseLease(leaseId: string) {
    this.calls.push({ name: "release", args: leaseId });
  }
}

class MemoryGoogle implements GoogleCalendarPort {
  readonly events = new Map<string, any>();
  readonly calls: string[] = [];
  readonly calendarTargets: string[] = [];
  listError: Error | undefined;
  writeError: Error | undefined;
  commitBeforeError = false;

  async listCalendars() {
    return [
      {
        id: CALENDAR,
        summary: "Primary",
        primary: true,
        writable: true,
      },
    ];
  }

  async listEventChanges(_token?: string, args?: { calendarId: string }) {
    if (args) this.calendarTargets.push(`list:${args.calendarId}`);
    if (this.listError) {
      const error = this.listError;
      this.listError = undefined;
      throw error;
    }
    return { events: [...this.events.values()], nextSyncToken: "sync-next" };
  }

  async getEvent(_token: string, args: { eventId: string }) {
    this.calendarTargets.push(
      `get:${(args as { calendarId: string }).calendarId}`,
    );
    const event = this.events.get(args.eventId);
    if (!event) throw new GoogleCalendarError("remote", "not-found");
    return event;
  }

  async insertEvent(_token: string, calendarId: string, args: any) {
    this.calendarTargets.push(`insert:${calendarId}`);
    this.calls.push(`insert:${args.googleEventId}`);
    const event = {
      id: args.googleEventId,
      calendarId,
      etag: '"etag-created"',
      summary: args.event.summary,
      startMs: args.event.startMs,
      endMs: args.event.endMs,
      allDay: false,
      status: "confirmed",
      updatedMs: 2,
      extendedProperties: { private: { qaliOperationId: args.id } },
    };
    if (this.commitBeforeError) this.events.set(args.googleEventId, event);
    if (this.writeError) throw this.writeError;
    this.events.set(args.googleEventId, event);
    return event;
  }

  async patchEvent(_token: string, args: any) {
    this.calendarTargets.push(`patch:${args.calendarId}`);
    this.calls.push(`patch:${args.eventId}`);
    if (this.commitBeforeError) {
      this.events.set(args.eventId, {
        ...this.events.get(args.eventId),
        ...args.patch,
        id: args.eventId,
        calendarId: args.calendarId,
        etag: '"etag-patched"',
        status: "confirmed",
        updatedMs: 3,
      });
    }
    if (this.writeError) throw this.writeError;
    return {
      ...this.events.get(args.eventId),
      ...args.patch,
      id: args.eventId,
      calendarId: args.calendarId,
      etag: '"etag-patched"',
      status: "confirmed",
      updatedMs: 3,
    };
  }

  async moveEvent(_token: string, args: any) {
    this.calendarTargets.push(
      `move:${args.calendarId}->${args.destinationCalendarId}`,
    );
    return {
      ...this.events.get(args.eventId),
      id: args.eventId,
      calendarId: args.destinationCalendarId,
      etag: '"etag-moved"',
      status: "confirmed",
    };
  }

  async respondToEvent() {
    throw new Error("unused");
  }

  async deleteEvent(_token: string, args: any) {
    this.calls.push(`delete:${args.eventId}`);
    if (this.commitBeforeError) this.events.delete(args.eventId);
    if (this.writeError) throw this.writeError;
    this.events.delete(args.eventId);
  }
}

function worker(
  broker: MemoryBroker,
  google: MemoryGoogle,
  options: Record<string, unknown> = {},
) {
  return new GoogleSyncWorker({
    accountId: ACCOUNT,
    broker,
    google,
    oauth: {
      accessToken: async () => "access-token",
      status: async () => ({ kind: "connected" as const }),
    },
    now: () => 10_000,
    random: () => 0,
    ...options,
  });
}

class FakeClock {
  now = 10_000;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  #nextTimerId = 1;

  readonly setTimer = ((callback: () => void, delay = 0) => {
    const id = this.#nextTimerId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  }) as unknown as typeof setTimeout;

  readonly clearTimer = ((id: number) => {
    this.timers.delete(id);
  }) as unknown as typeof clearTimeout;

  async advanceBy(durationMs: number): Promise<void> {
    this.now += durationMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.now)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
      await flushWorker();
    }
  }
}

async function flushWorker(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

describe("GoogleSyncWorker", () => {
  test("rejects a wrong-account calendar before reading its Google events", async () => {
    const broker = new MemoryBroker();
    broker.calendars[0]!.accountId = "account-attacker";
    const google = new MemoryGoogle();
    const sync = worker(broker, google);

    sync.start();
    await flushWorker();

    expect(google.calendarTargets).toEqual([]);
    expect(google.calls).toEqual([]);
    await sync.stop();
  });

  test("rejects a wrong-account lease before writing to Google", async () => {
    const broker = new MemoryBroker();
    broker.operations.push(operation({ accountId: "account-attacker" }));
    const google = new MemoryGoogle();
    const sync = worker(broker, google);

    sync.start();
    await flushWorker();

    expect(google.calls).toEqual([]);
    expect(sync.status.kind).toBe("offline");
    await sync.stop();
  });

  test("runs autonomous sync cycles through the supervisor's shared gate", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    let gatedCycles = 0;
    const sync = worker(broker, google, {
      cycleGate: {
        run: async (task: () => Promise<void>) => {
          gatedCycles += 1;
          return await task();
        },
      },
    });

    sync.start();
    await flushWorker();

    expect(gatedCycles).toBe(1);
    await sync.stop();
  });

  test("keeps local calendar keys in Convex while every Google pull uses the provider calendar id", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();

    await worker(broker, google).runOnce();

    expect(google.calendarTargets).toContain(`list:${PROVIDER_CALENDAR}`);
    expect(
      broker.calls.find((call) => call.name === "complete-sync")?.args,
    ).toMatchObject({
      accountId: ACCOUNT,
      calendarId: CALENDAR,
    });
    expect(
      broker.calls.some(
        (call) =>
          call.name === "complete-sync" &&
          (call.args as { calendarId?: string }).calendarId ===
            PROVIDER_CALENDAR,
      ),
    ).toBe(false);
  });

  test("uses provider ids for source and destination Google writes while receipts keep local keys", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.events.set("remote-1", {
      id: "remote-1",
      calendarId: PROVIDER_CALENDAR,
      etag: '"etag-before"',
      startMs: START,
      endMs: START + 30 * 60_000,
      allDay: false,
      status: "confirmed",
    });
    broker.operations.push(
      operation({
        kind: "move",
        remoteEventId: "remote-1",
        uploadBaseRemoteEtag: '"etag-before"',
        payload: {
          destinationCalendarId: DESTINATION_CALENDAR,
          destinationProviderCalendarId: DESTINATION_PROVIDER_CALENDAR,
        },
      }),
    );

    await worker(broker, google).runOnce();

    expect(google.calendarTargets).toContain(
      `move:${PROVIDER_CALENDAR}->${DESTINATION_PROVIDER_CALENDAR}`,
    );
    const success = broker.calls.find((call) => call.name === "success")
      ?.args as {
      remoteSnapshot?: { calendarId?: string; providerCalendarId?: string };
    };
    expect(success.remoteSnapshot).toMatchObject({
      calendarId: DESTINATION_CALENDAR,
      providerCalendarId: DESTINATION_PROVIDER_CALENDAR,
    });
  });
  test("main-process connectivity monitoring wakes only on an offline-to-online transition", () => {
    let online = false;
    let poll!: () => void;
    const wakes: string[] = [];
    const stop = monitorOnlineRestoration({
      isOnline: () => online,
      wake: (trigger) => wakes.push(trigger),
      setInterval: ((listener: () => void) => {
        poll = listener;
        return 1;
      }) as any,
      clearInterval: (() => {}) as any,
    });

    poll();
    online = true;
    poll();
    poll();
    stop();

    expect(wakes).toEqual(["online"]);
  });

  test("pulls remote-only changes on a bounded periodic timer while connected", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    const clock = new FakeClock();
    let pulls = 0;
    google.listEventChanges = async () => {
      pulls += 1;
      return { events: [], nextSyncToken: `sync-${pulls}` };
    };
    const sync = worker(broker, google, {
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      pullIntervalMs: 60_000,
    });

    sync.start();
    await flushWorker();
    expect(pulls).toBe(1);

    await clock.advanceBy(60_000);

    expect(pulls).toBe(2);
    await sync.stop();
  });

  test.each(["retry-deadline", "manual", "online"] as const)(
    "retries a transient access-token failure when woken by %s",
    async (trigger) => {
      const broker = new MemoryBroker();
      const google = new MemoryGoogle();
      const clock = new FakeClock();
      let accessAttempts = 0;
      const sync = new GoogleSyncWorker({
        accountId: ACCOUNT,
        broker,
        google,
        oauth: {
          accessToken: async () => {
            accessAttempts += 1;
            if (accessAttempts === 1)
              throw new Error("temporary token failure");
            return "access-token";
          },
          status: async () => ({ kind: "connected" }),
        },
        now: () => clock.now,
        random: () => 0,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      });

      await sync.runOnce();
      expect(sync.status).toEqual({ kind: "offline", retryAt: 11_000 });

      sync.wake(trigger);
      await flushWorker();

      expect(accessAttempts).toBe(2);
      expect(sync.status).toEqual({ kind: "idle" });
      await sync.stop();
    },
  );

  test.each([
    "GOOGLE_OAUTH_NOT_CONNECTED",
    "GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE",
  ])(
    "keeps terminal credential error %s authentication-required",
    async (code) => {
      const broker = new MemoryBroker();
      const google = new MemoryGoogle();
      const sync = new GoogleSyncWorker({
        accountId: ACCOUNT,
        broker,
        google,
        oauth: {
          accessToken: async () => {
            throw new Error(code);
          },
          status: async () => ({ kind: "connected" }),
        },
        random: () => 0,
      });

      await sync.runOnce();

      expect(sync.status).toEqual({ kind: "authentication-required" });
    },
  );

  test("contains an upload broker rejection and schedules a retry status", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    const clock = new FakeClock();
    broker.leaseOperations = async () => {
      throw new Error("broker unavailable");
    };
    const statuses: string[] = [];
    const sync = worker(broker, google, {
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sync.onStatus((status) => statuses.push(status.kind));

    sync.start();
    await flushWorker();

    expect(statuses).toContain("offline");
    expect(sync.status).toEqual({ kind: "offline", retryAt: 11_000 });
    expect(clock.timers.size).toBe(1);
    await sync.stop();
  });

  test("stop clears timers and joins in-flight worker work", async () => {
    const periodicClock = new FakeClock();
    const periodicSync = worker(new MemoryBroker(), new MemoryGoogle(), {
      now: () => periodicClock.now,
      setTimer: periodicClock.setTimer,
      clearTimer: periodicClock.clearTimer,
      pullIntervalMs: 60_000,
    });
    periodicSync.start();
    await flushWorker();
    expect(periodicClock.timers.size).toBe(1);
    await periodicSync.stop();
    expect(periodicClock.timers.size).toBe(0);

    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    const clock = new FakeClock();
    broker.operations.push(operation());
    let writeStarted!: () => void;
    const startedWriting = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const originalInsert = google.insertEvent.bind(google);
    google.insertEvent = async (token, calendarId, args) => {
      writeStarted();
      await new Promise<void>((resolve) => {
        args.signal.addEventListener("abort", resolve, { once: true });
      });
      return await originalInsert(token, calendarId, args);
    };
    const sync = worker(broker, google, {
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      drainTimeoutMs: 5,
      pullIntervalMs: 60_000,
    });

    sync.start();
    await startedWriting;
    expect(clock.timers.size).toBe(1);
    await sync.stop();

    expect(clock.timers.size).toBe(0);
    expect(sync.status).toEqual({ kind: "stopped" });
  });

  test("quit reaches local backend teardown after the sync drain deadline", async () => {
    const calls: string[] = [];
    await shutdownSyncBeforeBackend({
      sync: {
        drain: async () => await new Promise(() => {}),
        stop: async () => {
          calls.push("sync-stop");
        },
      },
      stopBackend: async () => {
        calls.push("backend-stop");
      },
      timeoutMs: 5,
    });

    expect(calls).toEqual(["sync-stop", "backend-stop"]);
  });

  test("timeout after committed create reconciles instead of reinserting", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.commitBeforeError = true;
    google.writeError = new GoogleCalendarError(
      "ambiguous",
      "write-outcome-unknown",
      { operationId: "operation_00000001" },
    );
    broker.operations.push(operation());
    const sync = worker(broker, google);

    await sync.runOnce();

    expect(
      google.calls.filter((call) => call.startsWith("insert:")),
    ).toHaveLength(1);
    expect(broker.status.get("operation_00000001")).toBe("succeeded");
  });

  test("ambiguous update and delete inspect the target before any retry", async () => {
    for (const kind of ["update", "delete"] as const) {
      const broker = new MemoryBroker();
      const google = new MemoryGoogle();
      google.events.set("remote-1", {
        id: "remote-1",
        calendarId: PROVIDER_CALENDAR,
        etag: '"etag-before"',
        summary: "Before",
        startMs: START,
        endMs: START + 30 * 60_000,
        allDay: false,
        status: "confirmed",
        updatedMs: 1,
      });
      google.commitBeforeError = true;
      google.writeError = new GoogleCalendarError(
        "ambiguous",
        "write-outcome-unknown",
      );
      broker.operations.push(
        operation({
          kind,
          remoteEventId: "remote-1",
          uploadBaseRemoteEtag: '"etag-before"',
          payload: kind === "update" ? { patch: { summary: "After" } } : {},
        }),
      );

      await worker(broker, google).runOnce();

      expect(broker.status.get("operation_00000001")).toBe("succeeded");
      expect(
        google.calls.filter((call) =>
          call.startsWith(kind === "update" ? "patch:" : "delete:"),
        ),
      ).toHaveLength(1);
    }
  });

  test("a deterministic create conflict after observed absence reconciles the racing event", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    broker.operations.push(operation({ leasedFromState: "ambiguous" }));
    google.insertEvent = async (_token, calendarId, args) => {
      google.calls.push(`insert:${args.googleEventId}`);
      google.events.set(args.googleEventId, {
        id: args.googleEventId,
        calendarId,
        etag: '"etag-race"',
        summary: args.event.summary,
        startMs: args.event.startMs,
        endMs: args.event.endMs,
        allDay: false,
        status: "confirmed",
        updatedMs: 2,
        extendedProperties: { private: { qaliOperationId: args.id } },
      });
      throw new GoogleCalendarError("conflict", "provider-rejected");
    };

    await worker(broker, google).runOnce();

    expect(broker.status.get("operation_00000001")).toBe("succeeded");
    expect(google.calls).toHaveLength(1);
  });

  test("410 replaces only the affected remote baseline before committing the new cursor", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.listError = new GoogleCalendarError("remote", "sync-token-expired");
    const sync = worker(broker, google);

    await sync.pull(CALENDAR);

    expect(broker.calls.map((call) => call.name)).toEqual([
      "begin-full",
      "page",
      "complete-sync",
    ]);
    expect((broker.calls[2]!.args as any).syncToken).toBe("sync-next");
    expect((broker.calls[1]!.args as any).fullSyncGeneration).toBe(7);
  });

  test("rate limit persists Retry-After and emits a rate-limit status", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    broker.operations.push(operation());
    google.writeError = new GoogleCalendarError(
      "rate-limit",
      "provider-rejected",
      { retryAfterMs: 45_000 },
    );
    const states: string[] = [];
    const sync = worker(broker, google);
    sync.onStatus((status) => states.push(status.kind));

    await sync.runOnce();

    expect(
      broker.calls.find((call) => call.name === "retry")?.args,
    ).toMatchObject({ retryAt: 55_000, safeError: "rate-limit" });
    expect(states).toContain("rate-limit");
  });

  test("an offline pull pauses writes until the retry wake", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    broker.operations.push(operation());
    google.listError = new GoogleCalendarError("network", "network-failure");

    await worker(broker, google).runOnce();

    expect(google.calls).toHaveLength(0);
    expect(broker.operations).toHaveLength(1);
  });

  test("a disabled Calendar API becomes a stable configuration issue", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.listCalendars = async () => {
      throw new GoogleCalendarError("validation", "api-not-configured", {
        status: 403,
      });
    };
    const sync = worker(broker, google);

    await sync.runOnce();

    expect(sync.status).toEqual({ kind: "configuration-required" });
  });

  test("repeated pull failures advance exponential backoff attempts", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.listEventChanges = async () => {
      throw new GoogleCalendarError("network", "network-failure");
    };
    const retryAt: number[] = [];
    const sync = worker(broker, google, {
      setTimer: (() => 1) as any,
      clearTimer: (() => {}) as any,
    });
    sync.onStatus((status) => {
      if (status.kind === "offline") retryAt.push(status.retryAt);
    });

    await sync.runOnce();
    await sync.runOnce();

    expect(retryAt).toEqual([11_000, 12_000]);
  });

  test("auth failure pauses uploads until a connection wake", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    broker.operations.push(operation());
    google.writeError = new GoogleCalendarError("auth", "provider-rejected");
    const sync = worker(broker, google);

    await sync.runOnce();
    broker.operations.push(operation({ operationId: "operation_00000002" }));
    await sync.runOnce();

    expect(google.calls).toHaveLength(1);
    google.writeError = undefined;
    sync.wake("connection");
    for (let index = 0; index < 10 && google.calls.length < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(google.calls).toHaveLength(2);
    await sync.drain();
  });

  test("an ambiguous committed move reconciles from the destination after source 404", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    const moved = {
      id: "remote-1",
      calendarId: "destination",
      etag: '"moved"',
      summary: "Moved",
      startMs: START,
      endMs: START + 30 * 60_000,
      allDay: false,
      status: "confirmed",
      updatedMs: 2,
    };
    google.getEvent = async (_token, args: any) => {
      if (args.calendarId === "destination") return moved;
      throw new GoogleCalendarError("remote", "not-found");
    };
    let moveCount = 0;
    google.moveEvent = async () => {
      moveCount += 1;
      return moved;
    };
    broker.operations.push(
      operation({
        kind: "move",
        remoteEventId: "remote-1",
        uploadBaseRemoteEtag: '"before"',
        leasedFromState: "ambiguous",
        payload: {
          destinationCalendarId: "gcal_destination",
          destinationProviderCalendarId: "destination",
        },
      }),
    );

    await worker(broker, google).runOnce();

    expect(moveCount).toBe(0);
    expect(broker.status.get("operation_00000001")).toBe("succeeded");
  });

  test("an ambiguous committed RSVP reconciles the self attendee without another write", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.events.set("remote-1", {
      id: "remote-1",
      calendarId: PROVIDER_CALENDAR,
      etag: '"after"',
      startMs: START,
      endMs: START + 30 * 60_000,
      allDay: false,
      status: "confirmed",
      updatedMs: 2,
      attendees: [
        { email: "me@example.com", self: true, responseStatus: "accepted" },
      ],
    });
    let responseCount = 0;
    google.respondToEvent = async () => {
      responseCount += 1;
      return google.events.get("remote-1");
    };
    broker.operations.push(
      operation({
        kind: "respond",
        remoteEventId: "remote-1",
        uploadBaseRemoteEtag: '"before"',
        leasedFromState: "ambiguous",
        payload: { responseStatus: "accepted" },
      }),
    );

    await worker(broker, google).runOnce();

    expect(responseCount).toBe(0);
    expect(broker.status.get("operation_00000001")).toBe("succeeded");
  });

  test.each([
    ["attendees", { attendees: [{ email: "new@example.com" }] }],
    ["recurrence", { recurrence: ["RRULE:FREQ=DAILY"] }],
    ["timezone", { timeZone: "Europe/Paris" }],
    ["conference", { conference: null }],
  ])(
    "ambiguous update compares %s before deciding it already committed",
    async (_name, patch) => {
      const broker = new MemoryBroker();
      const google = new MemoryGoogle();
      google.events.set("remote-1", {
        id: "remote-1",
        calendarId: PROVIDER_CALENDAR,
        etag: '"before"',
        startMs: START,
        endMs: START + 30 * 60_000,
        allDay: false,
        status: "confirmed",
        attendees: [{ email: "old@example.com" }],
        recurrence: ["RRULE:FREQ=WEEKLY"],
        start: { timeZone: "UTC" },
        conferenceUrl: "https://meet.google.com/existing",
      });
      broker.operations.push(
        operation({
          kind: "update",
          remoteEventId: "remote-1",
          uploadBaseRemoteEtag: '"before"',
          leasedFromState: "ambiguous",
          payload: { patch: patch as any },
        }),
      );

      await worker(broker, google).runOnce();

      expect(google.calls).toContain("patch:remote-1");
    },
  );

  test("a committed rich update reconciles attendees, recurrence, timezone, and conference identity", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.events.set("remote-1", {
      id: "remote-1",
      calendarId: PROVIDER_CALENDAR,
      etag: '"after"',
      startMs: START,
      endMs: START + 30 * 60_000,
      allDay: false,
      status: "confirmed",
      attendees: [{ email: "new@example.com", optional: true }],
      recurrence: ["RRULE:FREQ=DAILY"],
      start: { timeZone: "Europe/Paris" },
      conferenceCreateRequest: {
        requestId: googleConferenceRequestIdForOperation("operation_00000001"),
        status: "success",
      },
    });
    broker.operations.push(
      operation({
        kind: "update",
        remoteEventId: "remote-1",
        uploadBaseRemoteEtag: '"before"',
        leasedFromState: "ambiguous",
        payload: {
          patch: {
            attendees: [{ email: "new@example.com", optional: true }],
            recurrence: ["RRULE:FREQ=DAILY"],
            timeZone: "Europe/Paris",
            conference: { requestId: "request-local" },
          },
        },
      }),
    );

    await worker(broker, google).runOnce();

    expect(google.calls).toHaveLength(0);
    expect(broker.status.get("operation_00000001")).toBe("succeeded");
  });

  test("stop aborts in-flight work and releases the exact durable lease", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    broker.operations.push(operation());
    let release!: () => void;
    google.insertEvent = async (_token, _calendar, args) => {
      google.calls.push(`insert:${args.googleEventId}`);
      await new Promise<void>((resolve) => {
        release = resolve;
        args.signal.addEventListener("abort", resolve, { once: true });
      });
      throw new GoogleCalendarError("network", "aborted", {
        operationId: args.id,
      });
    };
    const sync = worker(broker, google, { drainTimeoutMs: 5 });
    sync.start();
    await broker.leaseStarted;

    await sync.stop();
    release?.();

    expect(broker.calls).toContainEqual({
      name: "release",
      args: expect.any(String),
    });
  });

  test("receipt persistence failure waits for sibling writes before releasing their shared lease", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    broker.operations.push(
      operation(),
      operation({
        operationId: "operation_00000002",
        localEventId: "local-2",
        payload: {
          event: {
            localEventId: "local-2",
            accountId: ACCOUNT,
            calendarId: CALENDAR,
            summary: "Second",
            startMs: START,
            endMs: START + 30 * 60_000,
            allDay: false,
            status: "confirmed",
          },
        },
      }),
    );
    let finishSecond!: () => void;
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const originalInsert = google.insertEvent.bind(google);
    google.insertEvent = async (token, calendarId, args) => {
      if (args.id === "operation_00000002") {
        secondStarted();
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
      }
      return await originalInsert(token, calendarId, args);
    };
    broker.recordRemoteSuccess = async (args: any) => {
      if (args.operationId === "operation_00000001") {
        throw new Error("CONVEX_RECEIPT_UNAVAILABLE");
      }
      broker.calls.push({ name: "success", args });
    };
    broker.recordRemoteFailure = async (args: any) => {
      if (args.operationId === "operation_00000001") {
        throw new Error("CONVEX_RECEIPT_UNAVAILABLE");
      }
      broker.calls.push({ name: "failure", args });
    };

    const run = worker(broker, google)
      .runOnce()
      .catch(() => {});
    await secondStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(broker.calls.some((call) => call.name === "release")).toBe(false);
    finishSecond();
    await run;
    expect(broker.calls.some((call) => call.name === "release")).toBe(true);
  });

  test("a committed insert with a lost success receipt releases into ambiguity without recording remote failure", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    broker.operations.push(operation());
    let failureCount = 0;
    broker.recordRemoteSuccess = async () => {
      throw new Error("CONVEX_RECEIPT_UNAVAILABLE");
    };
    broker.recordRemoteFailure = async (args: any) => {
      failureCount += 1;
      broker.status.set(args.operationId, "failed");
    };
    broker.releaseLease = async (leaseId: string) => {
      broker.calls.push({ name: "release", args: leaseId });
      if (!broker.status.has("operation_00000001")) {
        broker.status.set("operation_00000001", "ambiguous");
      }
    };

    await worker(broker, google).runOnce();

    expect(
      google.calls.filter((call) => call.startsWith("insert:")),
    ).toHaveLength(1);
    expect(failureCount).toBe(0);
    expect(broker.status.get("operation_00000001")).toBe("ambiguous");
  });

  test("start is idempotent and never creates a duplicate queue observer", async () => {
    const broker = new MemoryBroker();
    const sync = worker(broker, new MemoryGoogle());

    sync.start();
    sync.start();
    await sync.drain();
    await sync.stop();

    expect(broker.subscribeCount).toBe(1);
  });

  test("drain stops accepting wakeups and unsubscribes the durable queue observer", async () => {
    const broker = new MemoryBroker();
    const sync = worker(broker, new MemoryGoogle());
    sync.start();

    await sync.drain();
    broker.signalPending();

    expect(broker.unsubscribeCount).toBe(1);
    expect(sync.status.kind).not.toBe("pending");
    await sync.stop();
  });

  test("drain returns at its deadline even when a remote call ignores cancellation", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.listCalendars = async () => await new Promise(() => {});
    const sync = worker(broker, google, { drainTimeoutMs: 5 });
    sync.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startedAt = Date.now();

    await sync.drain();

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(broker.unsubscribeCount).toBe(1);
  });

  test("recurrence scopes target occurrence, master, and split primitives explicitly", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.events.set("master-1", {
      id: "master-1",
      calendarId: PROVIDER_CALENDAR,
      etag: '"master-etag"',
      startMs: START,
      endMs: START + 30 * 60_000,
      allDay: false,
      status: "confirmed",
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
    const update = operation({
      kind: "update",
      remoteEventId: "occurrence-1",
      uploadBaseRemoteEtag: '"occurrence-etag"',
      uploadBaseRemoteSnapshot: {
        localEventId: "local-1",
        accountId: ACCOUNT,
        calendarId: CALENDAR,
        remoteEventId: "occurrence-1",
        summary: "Planning",
        startMs: START,
        endMs: START + 30 * 60_000,
        allDay: false,
        status: "confirmed",
      },
      payload: {
        patch: { summary: "Changed", recurrenceScope: "thisEvent" },
      },
      recurrence: {
        recurringEventId: "master-1",
        occurrenceStartMs: START,
      },
    });
    broker.operations.push(update);
    await worker(broker, google).runOnce();
    expect(google.calls).toContain("patch:occurrence-1");

    broker.operations.push(
      operation({
        ...update,
        operationId: "operation_00000002",
        payload: {
          patch: { summary: "Changed", recurrenceScope: "allEvents" },
        },
      }),
    );
    await worker(broker, google).runOnce();
    expect(google.calls).toContain("patch:master-1");

    broker.operations.push(
      operation({
        ...update,
        operationId: "operation_00000003",
        payload: {
          patch: { summary: "Changed", recurrenceScope: "thisAndFollowing" },
        },
      }),
    );
    await worker(broker, google).runOnce();
    expect(
      google.calls.filter((call) => call === "patch:master-1").length,
    ).toBe(2);
    expect(google.calls.some((call) => call.startsWith("insert:"))).toBe(true);
  });

  test("a failed future-series insert stays ambiguous after the master was trimmed", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.events.set("master-1", {
      id: "master-1",
      calendarId: PROVIDER_CALENDAR,
      etag: '"master-etag"',
      startMs: START,
      endMs: START + 30 * 60_000,
      allDay: false,
      status: "confirmed",
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
    google.insertEvent = async () => {
      throw new GoogleCalendarError("validation", "provider-rejected");
    };
    broker.operations.push(
      operation({
        kind: "update",
        remoteEventId: "occurrence-1",
        uploadBaseRemoteEtag: '"occurrence-etag"',
        uploadBaseRemoteSnapshot: {
          localEventId: "local-1",
          accountId: ACCOUNT,
          calendarId: CALENDAR,
          remoteEventId: "occurrence-1",
          summary: "Planning",
          startMs: START,
          endMs: START + 30 * 60_000,
          allDay: false,
          status: "confirmed",
        },
        payload: {
          patch: { summary: "Changed", recurrenceScope: "thisAndFollowing" },
        },
        recurrence: {
          recurringEventId: "master-1",
          occurrenceStartMs: START,
        },
      }),
    );

    await worker(broker, google).runOnce();

    expect(google.calls).toContain("patch:master-1");
    expect(broker.status.get("operation_00000001")).toBe("ambiguous");
    expect(broker.calls.some((call) => call.name === "failure")).toBe(false);
  });

  test("this-and-following preserves explicit future start and end edits", async () => {
    const broker = new MemoryBroker();
    const google = new MemoryGoogle();
    google.events.set("master-1", {
      id: "master-1",
      calendarId: PROVIDER_CALENDAR,
      etag: '"master-etag"',
      startMs: START,
      endMs: START + 30 * 60_000,
      allDay: false,
      status: "confirmed",
      recurrence: ["RRULE:FREQ=WEEKLY"],
    });
    let inserted: any;
    const originalInsert = google.insertEvent.bind(google);
    google.insertEvent = async (token, calendarId, args) => {
      inserted = args.event;
      return await originalInsert(token, calendarId, args);
    };
    const editedStart = START + 60 * 60_000;
    const editedEnd = editedStart + 45 * 60_000;
    broker.operations.push(
      operation({
        kind: "update",
        remoteEventId: "occurrence-1",
        uploadBaseRemoteEtag: '"occurrence-etag"',
        uploadBaseRemoteSnapshot: {
          localEventId: "local-1",
          accountId: ACCOUNT,
          calendarId: CALENDAR,
          remoteEventId: "occurrence-1",
          startMs: START,
          endMs: START + 30 * 60_000,
          allDay: false,
          status: "confirmed",
        },
        payload: {
          patch: {
            startMs: editedStart,
            endMs: editedEnd,
            recurrenceScope: "thisAndFollowing",
          },
        },
        recurrence: {
          recurringEventId: "master-1",
          occurrenceStartMs: START,
        },
      }),
    );

    await worker(broker, google).runOnce();

    expect(inserted).toMatchObject({ startMs: editedStart, endMs: editedEnd });
  });
});
