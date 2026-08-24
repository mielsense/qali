import { createHash } from "node:crypto";

import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import type { LocalJwtTokenProvider } from "./auth/jwt";
import type { ConvexCalendarBrokerClient } from "./convex/broker-client";
import { googleAccountId } from "./google/token-store";

const ACCOUNT_SUBJECT = "qali-packaged-smoke-subject-v1";
const ACCOUNT_ID = googleAccountId(ACCOUNT_SUBJECT);
const PROVIDER_CALENDAR_ID = "qali-packaged-smoke-calendar-v1";
const LOCAL_CALENDAR_ID = `gcal_${createHash("sha256")
  .update(`${ACCOUNT_ID}\0${PROVIDER_CALENDAR_ID}`, "utf8")
  .digest("base64url")}`;
const KEPT_OPERATION_ID = "qali-smoke-create";
const DELETED_OPERATION_ID = "qali-smoke-delete";
const EDITED_SUMMARY = "Qali packaged smoke edited";

type SmokeEvent = Readonly<{
  _id?: string;
  localEventId?: string;
  summary?: string;
}>;

type PackagedSmokeCalendarClient = Pick<ConvexClient, "action" | "query">;
type PackagedSmokeCalendarBroker = Pick<
  ConvexCalendarBrokerClient,
  "applyRemoteCalendars" | "attachGoogleAccount" | "pendingOperationCount"
>;

export function assertPackagedSmokeState(
  events: readonly SmokeEvent[],
  pendingCount: number,
): { eventCount: number; pendingCount: number } {
  const kept = events.filter(
    (event) => event.summary === EDITED_SUMMARY,
  );
  const deleted = events.some(
    (event) => event.summary === "Qali packaged smoke disposable",
  );
  if (
    kept.length !== 1 ||
    deleted ||
    !Number.isSafeInteger(pendingCount) ||
    pendingCount < 1
  ) {
    throw new Error("PACKAGED_SMOKE_CALENDAR_STATE_INVALID");
  }
  return { eventCount: events.length, pendingCount };
}

export async function runPackagedSmokeCalendarScenario(options: Readonly<{
  broker: PackagedSmokeCalendarBroker;
  client: PackagedSmokeCalendarClient;
  phase: "seed" | "verify";
}>): Promise<{ eventCount: number; pendingCount: number }> {
  const action = (name: string) =>
    makeFunctionReference<"action">(`calendar:${name}`);
  const query = (name: string) =>
    makeFunctionReference<"query">(`calendar:${name}`);
  if (options.phase === "seed") {
    await options.broker.attachGoogleAccount({
      accountEmail: "packaged-smoke@qali.local",
      accountId: ACCOUNT_ID,
      providerAccountId: ACCOUNT_SUBJECT,
    });
    await options.broker.applyRemoteCalendars(ACCOUNT_ID, [
      {
        accessRole: "owner",
        id: PROVIDER_CALENDAR_ID,
        primary: true,
        selected: true,
        summary: "Qali packaged smoke",
        timeZone: "Europe/Paris",
        writable: true,
      },
    ]);
    const startMs = Date.UTC(2032, 0, 10, 9, 0, 0);
    await options.client.action(action("createEvent"), {
      calendarId: LOCAL_CALENDAR_ID,
      endMs: startMs + 3_600_000,
      operationId: KEPT_OPERATION_ID,
      startMs,
      summary: "Qali packaged smoke",
      timeZone: "Europe/Paris",
    });
    const eventsAfterCreate = (await options.client.query(
      query("listEvents"),
      {},
    )) as SmokeEvent[];
    const kept = eventsAfterCreate.find(
      (event) => event.summary === "Qali packaged smoke",
    );
    if (typeof kept?._id !== "string") {
      throw new Error("PACKAGED_SMOKE_CALENDAR_STATE_INVALID");
    }
    await options.client.action(action("updateEvent"), {
      eventId: kept._id,
      operationId: "qali-smoke-update",
      summary: EDITED_SUMMARY,
    });
    const disposable = (await options.client.action(action("createEvent"), {
      calendarId: LOCAL_CALENDAR_ID,
      endMs: startMs + 7_200_000,
      operationId: DELETED_OPERATION_ID,
      startMs: startMs + 3_600_000,
      summary: "Qali packaged smoke disposable",
      timeZone: "Europe/Paris",
    })) as { localEventId?: string };
    const eventsBeforeDelete = (await options.client.query(
      query("listEvents"),
      {},
    )) as SmokeEvent[];
    const disposableRow = eventsBeforeDelete.find(
      (event) => event.localEventId === disposable.localEventId,
    );
    if (typeof disposableRow?._id !== "string") {
      throw new Error("PACKAGED_SMOKE_CALENDAR_STATE_INVALID");
    }
    await options.client.action(action("deleteEvent"), {
      eventId: disposableRow._id,
      operationId: "qali-smoke-delete-accept",
    });
  }
  const events = (await options.client.query(
    query("listEvents"),
    {},
  )) as SmokeEvent[];
  return assertPackagedSmokeState(
    events,
    await options.broker.pendingOperationCount(ACCOUNT_ID),
  );
}

export async function runPackagedSmokeScenario(options: Readonly<{
  broker: ConvexCalendarBrokerClient;
  deploymentUrl: string;
  phase: "seed" | "verify";
  tokenProvider: LocalJwtTokenProvider;
}>): Promise<{ eventCount: number; pendingCount: number }> {
  const client = new ConvexClient(options.deploymentUrl, {
    logger: false,
    unsavedChangesWarning: false,
  });
  client.setAuth(async ({ forceRefreshToken }) =>
    options.tokenProvider.getToken({ forceRefreshToken }),
  );
  try {
    return await runPackagedSmokeCalendarScenario({
      broker: options.broker,
      client,
      phase: options.phase,
    });
  } finally {
    await client.close();
  }
}
