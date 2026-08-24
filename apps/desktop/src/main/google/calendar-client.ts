import { GoogleCalendarError, googleValidationError } from "./errors";
import {
  assertGoogleWriteIdentity,
  isGoogleJsonObject,
  mapGoogleAttendees,
  mapGoogleCalendar,
  mapGoogleEvent,
  mapGoogleEventWrite,
  type GoogleJsonObject,
} from "./mappers";
import type {
  GoogleAvailability,
  GoogleCalendar,
  GoogleDeleteOperation,
  GoogleEvent,
  GoogleEventChanges,
  GoogleInsertOperation,
  GoogleMoveOperation,
  GooglePatchOperation,
  GoogleRespondOperation,
  GoogleSendUpdates,
} from "./types";

export const GOOGLE_CALENDAR_API_BASE =
  "https://www.googleapis.com/calendar/v3" as const;

export type GoogleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GoogleCalendarClientOptions = Readonly<{
  fetch?: GoogleFetch;
  timeoutMs?: number;
}>;

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_PAGES = 100;
const MAX_ACCUMULATED_ITEMS = 50_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MAX_SEGMENT_LENGTH = 2_048;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_CURSOR_LENGTH = 8_192;

type RequestOptions = Readonly<{
  body?: unknown;
  etag?: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  operationId?: string;
  query?: URLSearchParams;
  signal: AbortSignal;
  write?: boolean;
}>;

type ParsedEvent = Readonly<{
  event: GoogleEvent;
  raw: GoogleJsonObject;
}>;

class InvalidGoogleResponseError extends Error {}
class GoogleResponseReadError extends Error {}

function invalidResponse(
  operationId?: string,
  ambiguous = false,
): GoogleCalendarError {
  return new GoogleCalendarError(
    ambiguous ? "ambiguous" : "remote",
    ambiguous ? "write-outcome-unknown" : "invalid-response",
    operationId === undefined ? {} : { operationId },
  );
}

function assertBoundedString(
  value: string,
  maximum: number,
  allowEmpty = false,
): void {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum ||
    /[\r\n\0]/.test(value)
  ) {
    throw googleValidationError();
  }
}

function pathSegment(value: string): string {
  assertBoundedString(value, MAX_SEGMENT_LENGTH);
  return encodeURIComponent(value);
}

function assertConfirmedEtag(
  value: string | undefined,
): asserts value is string {
  if (value === undefined) throw googleValidationError();
  assertBoundedString(value, 2_048);
}

/** The raw REST primitive cannot implement a recurrence scope. Task 10 must
 * resolve the exact instance/master id or perform a series split first. */
function assertResolvedPrimitiveTarget(operation: object): void {
  if ("recurrenceScope" in operation) throw googleValidationError();
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null || header.length > 128) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

const AUTH_ERROR_REASONS = new Set([
  "authError",
  "invalidCredentials",
  "invalidAuthenticationCredentials",
  "unauthorized",
]);
const RATE_LIMIT_ERROR_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "calendarUsageLimitsExceeded",
]);
const PERMANENT_OPERATION_ERROR_REASONS = new Set([
  "forbidden",
  "forbiddenForNonOrganizer",
  "insufficientPermissions",
  "requiredAccessLevel",
]);
const API_NOT_CONFIGURED_REASON = "accessNotConfigured";

function errorReasons(value: unknown): ReadonlySet<string> {
  if (!isGoogleJsonObject(value) || !isGoogleJsonObject(value.error)) {
    return new Set();
  }
  const errors = value.error.errors;
  if (!Array.isArray(errors) || errors.length > 16) return new Set();
  const reasons = new Set<string>();
  for (const entry of errors) {
    if (!isGoogleJsonObject(entry)) return new Set();
    const reason = entry.reason;
    if (
      typeof reason !== "string" ||
      reason.length === 0 ||
      reason.length > 128 ||
      /[\r\n\0]/.test(reason)
    ) {
      return new Set();
    }
    reasons.add(reason);
  }
  return reasons;
}

function classifyHttpError(
  response: Response,
  body: unknown,
  options: RequestOptions,
): GoogleCalendarError {
  const status = response.status;
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  const operation = options.operationId;
  const detail = {
    ...(operation === undefined ? {} : { operationId: operation }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    status,
  };
  if (status === 410) {
    return new GoogleCalendarError("remote", "sync-token-expired", detail);
  }
  const reasons = errorReasons(body);
  if (status === 403 && reasons.has(API_NOT_CONFIGURED_REASON)) {
    return new GoogleCalendarError("validation", "api-not-configured", detail);
  }
  if (
    status === 429 ||
    (status === 403 &&
      [...reasons].some((reason) => RATE_LIMIT_ERROR_REASONS.has(reason)))
  ) {
    return new GoogleCalendarError("rate-limit", "provider-rejected", detail);
  }
  if (
    status === 401 ||
    (status === 403 &&
      [...reasons].some((reason) => AUTH_ERROR_REASONS.has(reason)))
  ) {
    return new GoogleCalendarError("auth", "provider-rejected", detail);
  }
  if (
    status === 403 &&
    [...reasons].some((reason) => PERMANENT_OPERATION_ERROR_REASONS.has(reason))
  ) {
    return new GoogleCalendarError("validation", "provider-rejected", detail);
  }
  if (status === 403) {
    return new GoogleCalendarError("remote", "provider-rejected", detail);
  }
  if (status === 409 || status === 412) {
    return new GoogleCalendarError("conflict", "provider-rejected", detail);
  }
  if (status === 404) {
    return new GoogleCalendarError("remote", "not-found", detail);
  }
  if (options.write && status >= 500) {
    return new GoogleCalendarError(
      "ambiguous",
      "write-outcome-unknown",
      detail,
    );
  }
  if (status === 400 || status === 405 || status === 422) {
    return new GoogleCalendarError("validation", "provider-rejected", detail);
  }
  return new GoogleCalendarError("remote", "provider-rejected", detail);
}

async function readBoundedBody(
  response: Response,
  allowAnyContentType: boolean,
): Promise<Uint8Array> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!allowAnyContentType && contentType !== "application/json") {
    throw new InvalidGoogleResponseError();
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RESPONSE_BYTES) {
      throw new InvalidGoogleResponseError();
    }
  }
  if (!response.body) throw new InvalidGoogleResponseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new InvalidGoogleResponseError();
      }
      chunks.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof InvalidGoogleResponseError) throw error;
    throw new GoogleResponseReadError();
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(source) as unknown;
  } catch {
    throw new InvalidGoogleResponseError();
  }
}

function responseItems(value: unknown): unknown[] {
  if (!isGoogleJsonObject(value)) throw new Error("INVALID_GOOGLE_RESPONSE");
  if (value.items === undefined) return [];
  if (!Array.isArray(value.items) || value.items.length > 1_000) {
    throw new Error("INVALID_GOOGLE_RESPONSE");
  }
  return value.items;
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH
  ) {
    throw new Error("INVALID_GOOGLE_RESPONSE");
  }
  return value;
}

function sendUpdatesQuery(
  value: GoogleSendUpdates | undefined,
): URLSearchParams {
  const query = new URLSearchParams();
  if (value !== undefined) query.set("sendUpdates", value);
  return query;
}

export class GoogleCalendarClient {
  readonly #fetch: GoogleFetch;
  readonly #timeoutMs: number;

  constructor(options: GoogleCalendarClientOptions = {}) {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
      throw googleValidationError();
    }
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = timeout;
  }

  async listCalendars(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<readonly GoogleCalendar[]> {
    const calendars: GoogleCalendar[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        maxResults: "250",
        showDeleted: "false",
        showHidden: "true",
      });
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const value = await this.#request(accessToken, "/users/me/calendarList", {
        query,
        signal,
      });
      if (!isGoogleJsonObject(value)) throw invalidResponse();
      try {
        for (const item of responseItems(value)) {
          if (isGoogleJsonObject(item) && item.deleted === true) {
            continue;
          }
          calendars.push(mapGoogleCalendar(item));
          if (calendars.length > MAX_ACCUMULATED_ITEMS) {
            throw new Error("INVALID_GOOGLE_RESPONSE");
          }
        }
        const next = optionalCursor(value.nextPageToken);
        if (next === undefined) return Object.freeze(calendars);
        if (seenTokens.has(next)) throw new Error("INVALID_GOOGLE_RESPONSE");
        seenTokens.add(next);
        pageToken = next;
      } catch {
        throw invalidResponse();
      }
    }
    throw invalidResponse();
  }

  async listEventChanges(
    accessToken: string,
    options: Readonly<{
      calendarId: string;
      syncToken?: string;
      timeMinMs?: number;
      timeMaxMs?: number;
      signal: AbortSignal;
    }>,
  ): Promise<GoogleEventChanges> {
    pathSegment(options.calendarId);
    if (options.syncToken !== undefined) {
      assertBoundedString(options.syncToken, MAX_CURSOR_LENGTH);
      if (options.timeMinMs !== undefined || options.timeMaxMs !== undefined) {
        throw googleValidationError();
      }
    } else if (
      !Number.isFinite(options.timeMinMs) ||
      !Number.isFinite(options.timeMaxMs) ||
      !(options.timeMinMs! < options.timeMaxMs!)
    ) {
      throw googleValidationError();
    }

    const events: GoogleEvent[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        maxResults: "250",
        showDeleted: "true",
        singleEvents: "true",
      });
      if (options.syncToken !== undefined) {
        query.set("syncToken", options.syncToken);
      } else {
        query.set("timeMin", new Date(options.timeMinMs!).toISOString());
        query.set("timeMax", new Date(options.timeMaxMs!).toISOString());
      }
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const value = await this.#request(
        accessToken,
        `/calendars/${pathSegment(options.calendarId)}/events`,
        { query, signal: options.signal },
      );
      if (!isGoogleJsonObject(value)) throw invalidResponse();
      try {
        for (const item of responseItems(value)) {
          events.push(mapGoogleEvent(item, options.calendarId));
          if (events.length > MAX_ACCUMULATED_ITEMS) {
            throw new Error("INVALID_GOOGLE_RESPONSE");
          }
        }
        const next = optionalCursor(value.nextPageToken);
        if (next === undefined) {
          return {
            events: Object.freeze(events),
            nextSyncToken: optionalCursor(value.nextSyncToken),
          };
        }
        if (seenTokens.has(next)) throw new Error("INVALID_GOOGLE_RESPONSE");
        seenTokens.add(next);
        pageToken = next;
      } catch {
        throw invalidResponse();
      }
    }
    throw invalidResponse();
  }

  async getEvent(
    accessToken: string,
    options: Readonly<{
      calendarId: string;
      eventId: string;
      signal: AbortSignal;
    }>,
  ): Promise<GoogleEvent> {
    return (
      await this.#getRawEvent(
        accessToken,
        options.calendarId,
        options.eventId,
        options.signal,
      )
    ).event;
  }

  async getAvailability(
    accessToken: string,
    options: Readonly<{
      calendarIds: readonly string[];
      timeMinMs: number;
      timeMaxMs: number;
      timeZone?: string;
      signal: AbortSignal;
    }>,
  ): Promise<GoogleAvailability> {
    if (
      options.calendarIds.length < 1 ||
      options.calendarIds.length > 50 ||
      !Number.isFinite(options.timeMinMs) ||
      !Number.isFinite(options.timeMaxMs) ||
      !(options.timeMinMs < options.timeMaxMs)
    ) {
      throw googleValidationError();
    }
    for (const calendarId of options.calendarIds) {
      assertBoundedString(calendarId, MAX_SEGMENT_LENGTH);
    }
    if (options.timeZone !== undefined) {
      assertBoundedString(options.timeZone, 128);
    }
    const value = await this.#request(accessToken, "/freeBusy", {
      method: "POST",
      signal: options.signal,
      body: {
        timeMin: new Date(options.timeMinMs).toISOString(),
        timeMax: new Date(options.timeMaxMs).toISOString(),
        ...(options.timeZone === undefined
          ? {}
          : { timeZone: options.timeZone }),
        items: options.calendarIds.map((id) => ({ id })),
      },
    });
    if (!isGoogleJsonObject(value) || !isGoogleJsonObject(value.calendars)) {
      throw invalidResponse();
    }
    const calendars: Record<
      string,
      {
        busy: { startMs: number; endMs: number }[];
        errors?: { domain?: string; reason?: string }[];
      }
    > = {};
    try {
      const entries = Object.entries(value.calendars);
      if (entries.length > 50) throw new Error("INVALID_GOOGLE_RESPONSE");
      for (const [calendarId, calendar] of entries) {
        if (!isGoogleJsonObject(calendar))
          throw new Error("INVALID_GOOGLE_RESPONSE");
        const busy = calendar.busy;
        if (!Array.isArray(busy) || busy.length > 10_000) {
          throw new Error("INVALID_GOOGLE_RESPONSE");
        }
        calendars[calendarId] = {
          busy: busy.map((range) => {
            if (
              !isGoogleJsonObject(range) ||
              typeof range.start !== "string" ||
              typeof range.end !== "string"
            ) {
              throw new Error("INVALID_GOOGLE_RESPONSE");
            }
            const startMs = Date.parse(range.start);
            const endMs = Date.parse(range.end);
            if (!Number.isFinite(startMs) || !(startMs < endMs)) {
              throw new Error("INVALID_GOOGLE_RESPONSE");
            }
            return { startMs, endMs };
          }),
          ...(Array.isArray(calendar.errors)
            ? {
                errors: calendar.errors.slice(0, 100).map((entry) => {
                  if (!isGoogleJsonObject(entry)) {
                    throw new Error("INVALID_GOOGLE_RESPONSE");
                  }
                  return {
                    ...(typeof entry.domain === "string"
                      ? { domain: entry.domain.slice(0, 128) }
                      : {}),
                    ...(typeof entry.reason === "string"
                      ? { reason: entry.reason.slice(0, 128) }
                      : {}),
                  };
                }),
              }
            : {}),
        };
      }
    } catch {
      throw invalidResponse();
    }
    return { calendars };
  }

  async insertEvent(
    accessToken: string,
    calendarId: string,
    operation: GoogleInsertOperation,
  ): Promise<GoogleEvent> {
    assertGoogleWriteIdentity(
      operation.id,
      operation.googleEventId,
      operation.conferenceRequestId,
    );
    const query = sendUpdatesQuery(operation.sendUpdates);
    if (operation.event.conference !== undefined) {
      query.set("conferenceDataVersion", "1");
    }
    const body = {
      ...mapGoogleEventWrite(operation.event),
      id: operation.googleEventId,
      extendedProperties: {
        private: { qaliOperationId: operation.id },
      },
      ...(operation.event.conference === "add"
        ? {
            conferenceData: {
              createRequest: {
                requestId: operation.conferenceRequestId,
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : operation.event.conference === "remove"
          ? { conferenceData: null }
          : {}),
    };
    const value = await this.#request(
      accessToken,
      `/calendars/${pathSegment(calendarId)}/events`,
      {
        method: "POST",
        body,
        query,
        signal: operation.signal,
        write: true,
        operationId: operation.id,
      },
    );
    return this.#mapWriteResponse(value, calendarId, operation.id);
  }

  async patchEvent(
    accessToken: string,
    operation: GooglePatchOperation,
  ): Promise<GoogleEvent> {
    assertResolvedPrimitiveTarget(operation);
    assertConfirmedEtag(operation.etag);
    assertGoogleWriteIdentity(
      operation.id,
      undefined,
      operation.patch.conference === "add"
        ? operation.conferenceRequestId
        : undefined,
    );
    if (
      operation.patch.conference === "add" &&
      operation.conferenceRequestId === undefined
    ) {
      throw googleValidationError();
    }
    const query = sendUpdatesQuery(operation.sendUpdates);
    if (operation.patch.conference !== undefined) {
      query.set("conferenceDataVersion", "1");
    }
    const body = {
      ...mapGoogleEventWrite(operation.patch),
      ...(operation.patch.conference === "add"
        ? {
            conferenceData: {
              createRequest: {
                requestId: operation.conferenceRequestId,
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          }
        : operation.patch.conference === "remove"
          ? { conferenceData: null }
          : {}),
    };
    const value = await this.#request(
      accessToken,
      `/calendars/${pathSegment(operation.calendarId)}/events/${pathSegment(operation.eventId)}`,
      {
        method: "PATCH",
        body,
        query,
        etag: operation.etag,
        signal: operation.signal,
        write: true,
        operationId: operation.id,
      },
    );
    return this.#mapWriteResponse(value, operation.calendarId, operation.id);
  }

  async moveEvent(
    accessToken: string,
    operation: GoogleMoveOperation,
  ): Promise<GoogleEvent> {
    assertResolvedPrimitiveTarget(operation);
    assertConfirmedEtag(operation.etag);
    assertGoogleWriteIdentity(operation.id);
    assertBoundedString(operation.destinationCalendarId, MAX_SEGMENT_LENGTH);
    const query = sendUpdatesQuery(operation.sendUpdates);
    query.set("destination", operation.destinationCalendarId);
    const value = await this.#request(
      accessToken,
      `/calendars/${pathSegment(operation.calendarId)}/events/${pathSegment(operation.eventId)}/move`,
      {
        method: "POST",
        query,
        etag: operation.etag,
        signal: operation.signal,
        write: true,
        operationId: operation.id,
      },
    );
    return this.#mapWriteResponse(
      value,
      operation.destinationCalendarId,
      operation.id,
    );
  }

  async respondToEvent(
    accessToken: string,
    operation: GoogleRespondOperation,
  ): Promise<GoogleEvent> {
    assertResolvedPrimitiveTarget(operation);
    assertConfirmedEtag(operation.etag);
    assertGoogleWriteIdentity(operation.id);
    const live = await this.#getRawEvent(
      accessToken,
      operation.calendarId,
      operation.eventId,
      operation.signal,
    );
    const attendees = mapGoogleAttendees(live.raw.attendees) ?? [];
    let foundSelf = false;
    const updated = attendees.map((attendee) => {
      if (!attendee.self) return attendee;
      foundSelf = true;
      return { ...attendee, responseStatus: operation.responseStatus };
    });
    if (!foundSelf) throw invalidResponse();
    const value = await this.#request(
      accessToken,
      `/calendars/${pathSegment(operation.calendarId)}/events/${pathSegment(operation.eventId)}`,
      {
        method: "PATCH",
        body: { attendees: updated },
        query: sendUpdatesQuery(operation.sendUpdates),
        etag: operation.etag,
        signal: operation.signal,
        write: true,
        operationId: operation.id,
      },
    );
    return this.#mapWriteResponse(value, operation.calendarId, operation.id);
  }

  async deleteEvent(
    accessToken: string,
    operation: GoogleDeleteOperation,
  ): Promise<void> {
    assertResolvedPrimitiveTarget(operation);
    assertConfirmedEtag(operation.etag);
    assertGoogleWriteIdentity(operation.id);
    await this.#request(
      accessToken,
      `/calendars/${pathSegment(operation.calendarId)}/events/${pathSegment(operation.eventId)}`,
      {
        method: "DELETE",
        query: sendUpdatesQuery(operation.sendUpdates),
        etag: operation.etag,
        signal: operation.signal,
        write: true,
        operationId: operation.id,
      },
    );
  }

  async #getRawEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    signal: AbortSignal,
  ): Promise<ParsedEvent> {
    const value = await this.#request(
      accessToken,
      `/calendars/${pathSegment(calendarId)}/events/${pathSegment(eventId)}`,
      { signal },
    );
    if (!isGoogleJsonObject(value)) throw invalidResponse();
    try {
      return { event: mapGoogleEvent(value, calendarId), raw: value };
    } catch {
      throw invalidResponse();
    }
  }

  #mapWriteResponse(
    value: unknown,
    calendarId: string,
    operationId: string,
  ): GoogleEvent {
    try {
      return mapGoogleEvent(value, calendarId);
    } catch {
      throw invalidResponse(operationId, true);
    }
  }

  async #request(
    accessToken: string,
    path: string,
    options: RequestOptions,
  ): Promise<unknown | null> {
    assertBoundedString(accessToken, MAX_TOKEN_LENGTH);
    if (!path.startsWith("/") || path.includes("\\") || path.includes("..")) {
      throw googleValidationError();
    }
    if (options.etag !== undefined) {
      assertBoundedString(options.etag, 2_048);
    }
    if (options.signal.aborted) {
      throw new GoogleCalendarError("network", "aborted", {
        ...(options.operationId === undefined
          ? {}
          : { operationId: options.operationId }),
      });
    }

    const url = new URL(`${GOOGLE_CALENDAR_API_BASE}${path}`);
    if (
      url.origin !== "https://www.googleapis.com" ||
      !url.pathname.startsWith("/calendar/v3/")
    ) {
      throw googleValidationError();
    }
    if (options.query !== undefined) url.search = options.query.toString();
    if (url.href.length > 16_384) throw googleValidationError();

    let body: string | undefined;
    if (options.body !== undefined) {
      try {
        body = JSON.stringify(options.body);
      } catch {
        throw googleValidationError();
      }
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        throw googleValidationError();
      }
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url.href, {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.etag === undefined ? {} : { "if-match": options.etag }),
        },
        ...(body === undefined ? {} : { body }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = parseJson(await readBoundedBody(response, true));
        } catch {
          errorBody = undefined;
        }
        throw classifyHttpError(response, errorBody, options);
      }
      if (response.status === 204) return null;
      try {
        return parseJson(await readBoundedBody(response, false));
      } catch (error) {
        if (error instanceof GoogleResponseReadError) {
          throw new GoogleCalendarError(
            options.write ? "ambiguous" : "network",
            options.write ? "write-outcome-unknown" : "network-failure",
            options.operationId === undefined
              ? {}
              : { operationId: options.operationId },
          );
        }
        throw invalidResponse(options.operationId, options.write === true);
      }
    } catch (error) {
      if (error instanceof GoogleCalendarError) throw error;
      throw new GoogleCalendarError(
        options.write ? "ambiguous" : "network",
        options.write ? "write-outcome-unknown" : "network-failure",
        options.operationId === undefined
          ? {}
          : { operationId: options.operationId },
      );
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", forwardAbort);
    }
  }
}
