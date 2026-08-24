// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import {
  GoogleCalendarClient,
  type GoogleFetch,
} from "../src/main/google/calendar-client";
import {
  GoogleCalendarError,
  isGoogleSyncTokenExpired,
} from "../src/main/google/errors";
import {
  googleConferenceRequestIdForOperation,
  googleEventIdForOperation,
} from "../src/main/google/mappers";
import type {
  GoogleInsertOperation,
  GooglePatchOperation,
} from "../src/main/google/types";

const TOKEN = "access-token-that-must-never-appear-in-errors";
const OPERATION_ID = "operation_0123456789";
const START = Date.parse("2026-08-18T09:00:00.000Z");
const END = Date.parse("2026-08-18T09:30:00.000Z");

type CapturedRequest = Readonly<{ input: string; init: RequestInit }>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function createFetch(
  handler: (
    request: CapturedRequest,
    index: number,
  ) => Response | Promise<Response>,
): { fetch: GoogleFetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = { input: String(input), init: init ?? {} };
    requests.push(request);
    return await handler(request, requests.length - 1);
  }) as GoogleFetch;
  return { fetch: fake, requests };
}

function insertOperation(
  overrides: Partial<GoogleInsertOperation> = {},
): GoogleInsertOperation {
  return {
    id: OPERATION_ID,
    googleEventId: googleEventIdForOperation(OPERATION_ID),
    conferenceRequestId: googleConferenceRequestIdForOperation(OPERATION_ID),
    etag: undefined,
    signal: new AbortController().signal,
    event: {
      summary: "Planning",
      startMs: START,
      endMs: END,
      allDay: false,
      timeZone: "Europe/Paris",
      conference: "add",
    },
    ...overrides,
  };
}

function patchOperation(
  overrides: Partial<GooglePatchOperation> = {},
): GooglePatchOperation {
  return {
    id: OPERATION_ID,
    calendarId: "work/team@example.com",
    eventId: "event/id+1",
    etag: '"etag-7"',
    signal: new AbortController().signal,
    patch: { summary: "Updated" },
    ...overrides,
  };
}

function successfulEvent(id = "event-1"): Record<string, unknown> {
  return {
    id,
    etag: '"etag-8"',
    status: "confirmed",
    summary: "Planning",
    start: { dateTime: "2026-08-18T09:00:00.000Z" },
    end: { dateTime: "2026-08-18T09:30:00.000Z" },
    updated: "2026-08-18T08:00:00.000Z",
  };
}

describe("GoogleCalendarClient HTTP contract", () => {
  test("create uses deterministic event and conference identities", async () => {
    const captured = createFetch(() => jsonResponse(successfulEvent()));
    const client = new GoogleCalendarClient({ fetch: captured.fetch });
    const operation = insertOperation();

    await client.insertEvent(TOKEN, "primary/calendar", operation);

    expect(captured.requests).toHaveLength(1);
    const request = captured.requests[0]!;
    expect(request.input).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary%2Fcalendar/events?conferenceDataVersion=1",
    );
    const body = JSON.parse(String(request.init.body)) as Record<string, any>;
    expect(body.id).toBe(operation.googleEventId);
    expect(body.extendedProperties.private.qaliOperationId).toBe(operation.id);
    expect(body.conferenceData.createRequest.requestId).toBe(
      operation.conferenceRequestId,
    );
    expect(body.start).toEqual({
      dateTime: "2026-08-18T09:00:00.000Z",
      timeZone: "Europe/Paris",
    });
  });

  test("update encodes path segments and sends the confirmed etag", async () => {
    const captured = createFetch(() => jsonResponse(successfulEvent()));
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await client.patchEvent(TOKEN, patchOperation());

    const request = captured.requests[0]!;
    expect(request.input).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/work%2Fteam%40example.com/events/event%2Fid%2B1",
    );
    expect(new Headers(request.init.headers).get("if-match")).toBe('"etag-7"');
  });

  test("calendar listing paginates on the fixed official origin", async () => {
    const captured = createFetch((request, index) => {
      const url = new URL(request.input);
      if (index === 0) {
        return jsonResponse({
          items: [
            {
              id: "primary@example.com",
              summary: "Primary",
              primary: true,
              accessRole: "owner",
            },
          ],
          nextPageToken: "page token/+",
        });
      }
      expect(url.searchParams.get("pageToken")).toBe("page token/+");
      return jsonResponse({
        items: [
          { id: "team@example.com", summary: "Team", accessRole: "reader" },
          {
            id: "hidden@example.com",
            summary: "Hidden in Google",
            accessRole: "reader",
            hidden: true,
            selected: false,
          },
        ],
      });
    });
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    const calendars = await client.listCalendars(
      TOKEN,
      new AbortController().signal,
    );

    expect(calendars.map((calendar) => calendar.id)).toEqual([
      "primary@example.com",
      "team@example.com",
      "hidden@example.com",
    ]);
    expect(calendars[2]).toMatchObject({ hidden: true, selected: false });
    expect(captured.requests).toHaveLength(2);
    expect(
      new URL(captured.requests[0]!.input).searchParams.get("showHidden"),
    ).toBe("true");
    expect(
      captured.requests.every(({ input }) =>
        input.startsWith("https://www.googleapis.com/calendar/v3/"),
      ),
    ).toBe(true);
  });

  test("event sync keeps its anchor across pages and preserves tombstones", async () => {
    const urls: URL[] = [];
    const captured = createFetch((request, index) => {
      const url = new URL(request.input);
      urls.push(url);
      return index === 0
        ? jsonResponse({
            items: [
              {
                id: "cancelled-instance",
                etag: '"gone"',
                status: "cancelled",
                recurringEventId: "series-1",
                originalStartTime: { dateTime: "2026-08-18T09:00:00Z" },
              },
            ],
            nextPageToken: "page-2",
          })
        : jsonResponse({
            items: [successfulEvent("changed")],
            nextSyncToken: "sync-next",
          });
    });
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    const result = await client.listEventChanges(TOKEN, {
      calendarId: "primary",
      syncToken: "sync-start",
      signal: new AbortController().signal,
    });

    expect(result.events[0]).toMatchObject({
      id: "cancelled-instance",
      etag: '"gone"',
      status: "cancelled",
      recurringEventId: "series-1",
      originalStartTime: { dateTime: "2026-08-18T09:00:00Z" },
    });
    expect(result.nextSyncToken).toBe("sync-next");
    expect(urls[0]!.searchParams.get("syncToken")).toBe("sync-start");
    expect(urls[1]!.searchParams.get("syncToken")).toBe("sync-start");
    expect(urls[1]!.searchParams.get("pageToken")).toBe("page-2");
    expect(urls[0]!.searchParams.has("timeMin")).toBe(false);
  });

  test("list, get, and write responses preserve Qali ownership and conference request state", async () => {
    const remote = {
      ...successfulEvent(),
      extendedProperties: {
        private: { qaliOperationId: OPERATION_ID, unrelated: "bounded" },
      },
      conferenceData: {
        createRequest: {
          requestId: googleConferenceRequestIdForOperation(OPERATION_ID),
          status: { statusCode: "pending" },
        },
        conferenceSolution: {
          key: { type: "hangoutsMeet" },
          name: "Google Meet",
        },
      },
    };
    const captured = createFetch((request) => {
      const url = new URL(request.input);
      return request.init.method === "POST" || url.pathname.endsWith("/event-1")
        ? jsonResponse(remote)
        : jsonResponse({ items: [remote], nextSyncToken: "next" });
    });
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    const read = await client.getEvent(TOKEN, {
      calendarId: "primary",
      eventId: "event-1",
      signal: new AbortController().signal,
    });
    const listed = await client.listEventChanges(TOKEN, {
      calendarId: "primary",
      timeMinMs: START,
      timeMaxMs: END,
      signal: new AbortController().signal,
    });
    const written = await client.insertEvent(
      TOKEN,
      "primary",
      insertOperation(),
    );

    for (const event of [read, listed.events[0], written]) {
      expect(event?.extendedProperties).toEqual({
        private: { qaliOperationId: OPERATION_ID },
      });
      expect(event?.conferenceCreateRequest).toEqual({
        requestId: googleConferenceRequestIdForOperation(OPERATION_ID),
        status: "pending",
      });
    }
  });

  test("a full sync is bounded and sync tokens cannot mix with time bounds", async () => {
    const captured = createFetch(() =>
      jsonResponse({ items: [], nextSyncToken: "next" }),
    );
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await client.listEventChanges(TOKEN, {
      calendarId: "primary",
      timeMinMs: START,
      timeMaxMs: END,
      signal: new AbortController().signal,
    });
    const url = new URL(captured.requests[0]!.input);
    expect(url.searchParams.get("timeMin")).toBe("2026-08-18T09:00:00.000Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-08-18T09:30:00.000Z");

    await expect(
      client.listEventChanges(TOKEN, {
        calendarId: "primary",
        syncToken: "sync",
        timeMinMs: START,
        timeMaxMs: END,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });

  test("freebusy posts only the requested calendars and maps busy ranges", async () => {
    const captured = createFetch(() =>
      jsonResponse({
        calendars: {
          "a/b@example.com": {
            busy: [
              {
                start: "2026-08-18T09:00:00.000Z",
                end: "2026-08-18T09:30:00.000Z",
              },
            ],
          },
        },
      }),
    );
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    const availability = await client.getAvailability(TOKEN, {
      calendarIds: ["a/b@example.com"],
      timeMinMs: START,
      timeMaxMs: END,
      timeZone: "Europe/Paris",
      signal: new AbortController().signal,
    });

    expect(captured.requests[0]!.input).toBe(
      "https://www.googleapis.com/calendar/v3/freeBusy",
    );
    expect(JSON.parse(String(captured.requests[0]!.init.body))).toEqual({
      timeMin: "2026-08-18T09:00:00.000Z",
      timeMax: "2026-08-18T09:30:00.000Z",
      timeZone: "Europe/Paris",
      items: [{ id: "a/b@example.com" }],
    });
    expect(availability.calendars["a/b@example.com"]?.busy).toEqual([
      { startMs: START, endMs: END },
    ]);
  });

  test("move encodes destination as query data and carries operation preconditions", async () => {
    const captured = createFetch(() => jsonResponse(successfulEvent()));
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await client.moveEvent(TOKEN, {
      id: OPERATION_ID,
      calendarId: "source/id",
      eventId: "event/id",
      destinationCalendarId: "destination/id@example.com",
      etag: '"etag-move"',
      signal: new AbortController().signal,
    });

    const request = captured.requests[0]!;
    const url = new URL(request.input);
    expect(url.pathname).toBe(
      "/calendar/v3/calendars/source%2Fid/events/event%2Fid/move",
    );
    expect(url.searchParams.get("destination")).toBe(
      "destination/id@example.com",
    );
    expect(new Headers(request.init.headers).get("if-match")).toBe(
      '"etag-move"',
    );
  });

  test("respond reads Google's attendee array and changes only the self attendee", async () => {
    const captured = createFetch((_request, index) =>
      index === 0
        ? jsonResponse({
            ...successfulEvent(),
            attendees: [
              {
                id: "profile-1",
                email: "me@example.com",
                self: true,
                responseStatus: "needsAction",
                comment: "keep",
              },
              { email: "guest@example.com", responseStatus: "accepted" },
            ],
          })
        : jsonResponse(successfulEvent()),
    );
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await client.respondToEvent(TOKEN, {
      id: OPERATION_ID,
      calendarId: "primary",
      eventId: "event-1",
      etag: '"etag-rsvp"',
      responseStatus: "accepted",
      signal: new AbortController().signal,
    });

    expect(captured.requests).toHaveLength(2);
    const body = JSON.parse(String(captured.requests[1]!.init.body));
    expect(body.attendees).toEqual([
      {
        id: "profile-1",
        email: "me@example.com",
        self: true,
        responseStatus: "accepted",
        comment: "keep",
      },
      { email: "guest@example.com", responseStatus: "accepted" },
    ]);
    expect(
      new Headers(captured.requests[1]!.init.headers).get("if-match"),
    ).toBe('"etag-rsvp"');
  });

  test("delete accepts Google's empty 204 response", async () => {
    const captured = createFetch(() => new Response(null, { status: 204 }));
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await client.deleteEvent(TOKEN, {
      id: OPERATION_ID,
      calendarId: "primary",
      eventId: "event-1",
      etag: '"etag-delete"',
      signal: new AbortController().signal,
    });

    expect(captured.requests).toHaveLength(1);
    expect(captured.requests[0]!.init.method).toBe("DELETE");
  });
});

describe("GoogleCalendarClient failure semantics", () => {
  test("maps status and Retry-After without exposing provider bodies or tokens", async () => {
    const cases = [
      [401, "auth"],
      [409, "conflict"],
      [412, "conflict"],
      [422, "validation"],
      [429, "rate-limit"],
      [500, "remote"],
    ] as const;

    for (const [status, kind] of cases) {
      const captured = createFetch(() =>
        jsonResponse(
          { error: { message: `secret body ${TOKEN}` } },
          { status, headers: { "retry-after": "7" } },
        ),
      );
      const client = new GoogleCalendarClient({ fetch: captured.fetch });
      const error = await client
        .getEvent(TOKEN, {
          calendarId: "primary",
          eventId: "event-1",
          signal: new AbortController().signal,
        })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(GoogleCalendarError);
      expect(error).toMatchObject({ kind, status });
      expect((error as GoogleCalendarError).retryAfterMs).toBe(7_000);
      expect(String((error as Error).message)).not.toContain(TOKEN);
      expect(String((error as Error).message)).not.toContain("secret body");
    }
  });

  test("classifies bounded 403 reasons without treating operation permissions as account auth", async () => {
    const cases = [
      ["authError", "auth"],
      ["invalidCredentials", "auth"],
      ["rateLimitExceeded", "rate-limit"],
      ["userRateLimitExceeded", "rate-limit"],
      ["quotaExceeded", "rate-limit"],
      ["forbiddenForNonOrganizer", "validation"],
      ["forbidden", "validation"],
      ["unknownProviderReason", "remote"],
    ] as const;

    for (const [reason, kind] of cases) {
      const captured = createFetch(() =>
        jsonResponse(
          {
            error: {
              errors: [
                {
                  domain: "calendar",
                  reason,
                  message: `must-not-leak ${TOKEN}`,
                },
              ],
            },
          },
          { status: 403, headers: { "retry-after": "5" } },
        ),
      );
      const client = new GoogleCalendarClient({ fetch: captured.fetch });
      const error = await client
        .getEvent(TOKEN, {
          calendarId: "primary",
          eventId: "event-1",
          signal: new AbortController().signal,
        })
        .catch((failure: unknown) => failure);

      expect(error).toMatchObject({ kind, status: 403 });
      expect(String((error as Error).message)).not.toContain(TOKEN);
      expect(String((error as Error).message)).not.toContain("must-not-leak");
      if (kind === "rate-limit") {
        expect((error as GoogleCalendarError).retryAfterMs).toBe(5_000);
      }
    }
  });

  test("identifies a Cloud project with the Calendar API disabled", async () => {
    const captured = createFetch(() =>
      jsonResponse(
        {
          error: {
            errors: [
              {
                domain: "usageLimits",
                reason: "accessNotConfigured",
              },
            ],
          },
        },
        { status: 403 },
      ),
    );
    const error = await new GoogleCalendarClient({ fetch: captured.fetch })
      .listCalendars(TOKEN, new AbortController().signal)
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      kind: "validation",
      code: "api-not-configured",
      status: 403,
    });
    expect(String(error)).toContain("not enabled");
  });

  test("classifies HTTP 410 as an expired sync token", async () => {
    const captured = createFetch(() =>
      jsonResponse({ error: { message: "Gone" } }, { status: 410 }),
    );
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    const error = await client
      .listEventChanges(TOKEN, {
        calendarId: "primary",
        syncToken: "old",
        signal: new AbortController().signal,
      })
      .catch((failure: unknown) => failure);

    expect(isGoogleSyncTokenExpired(error)).toBe(true);
    expect(error).toMatchObject({ kind: "remote", code: "sync-token-expired" });
  });

  test("a missing event is a definitive not-found result for reconciliation", async () => {
    const captured = createFetch(() =>
      jsonResponse({ error: { message: "Not found" } }, { status: 404 }),
    );
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await expect(
      client.getEvent(TOKEN, {
        calendarId: "primary",
        eventId: googleEventIdForOperation(OPERATION_ID),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      kind: "remote",
      code: "not-found",
      status: 404,
    });
  });

  test("a lost write response is ambiguous and is never retried", async () => {
    let attempts = 0;
    const captured = createFetch(() => {
      attempts += 1;
      throw new TypeError("socket closed");
    });
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    const error = await client
      .insertEvent(TOKEN, "primary", insertOperation())
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      kind: "ambiguous",
      operationId: OPERATION_ID,
    });
    expect(attempts).toBe(1);
  });

  test("a read network loss is network, while a write 5xx is ambiguous", async () => {
    const networkFetch = createFetch(() => {
      throw new TypeError("offline");
    });
    const networkClient = new GoogleCalendarClient({
      fetch: networkFetch.fetch,
    });
    await expect(
      networkClient.getEvent(TOKEN, {
        calendarId: "primary",
        eventId: "event-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "network" });

    const remoteFetch = createFetch(() =>
      jsonResponse({ error: {} }, { status: 503 }),
    );
    const remoteClient = new GoogleCalendarClient({ fetch: remoteFetch.fetch });
    await expect(
      remoteClient.patchEvent(TOKEN, patchOperation()),
    ).rejects.toMatchObject({ kind: "ambiguous", status: 503 });
  });

  test("rejects wrong content types and oversized responses", async () => {
    const wrongType = createFetch(
      () =>
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    await expect(
      new GoogleCalendarClient({ fetch: wrongType.fetch }).getEvent(TOKEN, {
        calendarId: "primary",
        eventId: "event-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "remote", code: "invalid-response" });

    const oversized = createFetch(
      () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024),
          },
        }),
    );
    await expect(
      new GoogleCalendarClient({ fetch: oversized.fetch }).getEvent(TOKEN, {
        calendarId: "primary",
        eventId: "event-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ kind: "remote", code: "invalid-response" });
  });

  test("rejects hostile ownership and conference metadata at mapping bounds", async () => {
    const cases = [
      {
        ...successfulEvent(),
        extendedProperties: {
          private: Object.fromEntries(
            Array.from({ length: 101 }, (_, index) => [`key-${index}`, "x"]),
          ),
        },
      },
      {
        ...successfulEvent(),
        conferenceData: {
          createRequest: {
            requestId: googleConferenceRequestIdForOperation(OPERATION_ID),
            status: { statusCode: "unexpected" },
          },
        },
      },
      {
        ...successfulEvent(),
        conferenceData: {
          createRequest: {
            requestId: "",
            status: { statusCode: "pending" },
          },
        },
      },
    ];

    for (const body of cases) {
      const captured = createFetch(() => jsonResponse(body));
      const client = new GoogleCalendarClient({ fetch: captured.fetch });
      await expect(
        client.getEvent(TOKEN, {
          calendarId: "primary",
          eventId: "event-1",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ kind: "remote", code: "invalid-response" });
    }
  });

  test("the response body remains under the request timeout", async () => {
    const captured = createFetch((request) => {
      const signal = request.init.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener(
              "abort",
              () => controller.error(new Error("aborted")),
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const client = new GoogleCalendarClient({
      fetch: captured.fetch,
      timeoutMs: 10,
    });

    const outcome = await Promise.race([
      client
        .getEvent(TOKEN, {
          calendarId: "primary",
          eventId: "event-1",
          signal: new AbortController().signal,
        })
        .then(
          () => "unexpected-success",
          (error: unknown) =>
            error instanceof GoogleCalendarError ? error.kind : "wrong-error",
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);

    expect(outcome).toBe("network");
  });

  test("invalid operation identity is rejected before network dispatch", async () => {
    const captured = createFetch(() => jsonResponse(successfulEvent()));
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await expect(
      client.insertEvent(
        TOKEN,
        "primary",
        insertOperation({ googleEventId: "caller-controlled" }),
      ),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(captured.requests).toHaveLength(0);
  });

  test("remote mutations require a confirmed etag before network dispatch", async () => {
    const captured = createFetch(() => jsonResponse(successfulEvent()));
    const client = new GoogleCalendarClient({ fetch: captured.fetch });

    await expect(
      client.patchEvent(TOKEN, patchOperation({ etag: undefined })),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(captured.requests).toHaveLength(0);
  });

  test("unresolved recurrence scopes never dispatch against a raw event id", async () => {
    const captured = createFetch(() => jsonResponse(successfulEvent()));
    const client = new GoogleCalendarClient({ fetch: captured.fetch });
    const signal = new AbortController().signal;
    const scopedOperations = [
      () =>
        client.patchEvent(TOKEN, {
          ...patchOperation(),
          recurrenceScope: "allEvents",
        } as GooglePatchOperation),
      () =>
        client.moveEvent(TOKEN, {
          id: OPERATION_ID,
          etag: '"etag"',
          calendarId: "primary",
          eventId: "raw-instance-id",
          destinationCalendarId: "destination",
          recurrenceScope: "thisAndFollowing",
          signal,
        } as Parameters<GoogleCalendarClient["moveEvent"]>[1]),
      () =>
        client.respondToEvent(TOKEN, {
          id: OPERATION_ID,
          etag: '"etag"',
          calendarId: "primary",
          eventId: "raw-instance-id",
          responseStatus: "accepted",
          recurrenceScope: "thisEvent",
          signal,
        } as Parameters<GoogleCalendarClient["respondToEvent"]>[1]),
      () =>
        client.deleteEvent(TOKEN, {
          id: OPERATION_ID,
          etag: '"etag"',
          calendarId: "primary",
          eventId: "raw-instance-id",
          recurrenceScope: "allEvents",
          signal,
        } as Parameters<GoogleCalendarClient["deleteEvent"]>[1]),
    ];

    for (const operation of scopedOperations) {
      await expect(operation()).rejects.toMatchObject({ kind: "validation" });
    }
    expect(captured.requests).toHaveLength(0);
  });
});
