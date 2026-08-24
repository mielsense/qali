import { googleValidationError } from "./errors";
import type {
  GoogleAttendee,
  GoogleCalendar,
  GoogleConferenceCreateRequest,
  GoogleDateTime,
  GoogleEvent,
  GoogleEventWrite,
  GoogleExtendedProperties,
  GooglePerson,
} from "./types";

const WRITABLE_ACCESS_ROLES = new Set(["owner", "writer"]);
const GOOGLE_EVENT_ID = /^[0-9a-v]{5,1024}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const MAX_TEXT_LENGTH = 10_000;
const MAX_EXTENDED_PROPERTY_COUNT = 100;
const MAX_EXTENDED_PROPERTY_KEY_LENGTH = 256;
const MAX_EXTENDED_PROPERTY_VALUE_LENGTH = 1_024;

export type GoogleJsonObject = Record<string, unknown>;

export function isGoogleJsonObject(value: unknown): value is GoogleJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function optionalString(
  value: unknown,
  maximum = MAX_TEXT_LENGTH,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  return value;
}

function requiredString(value: unknown, maximum = 2_048): string {
  const result = optionalString(value, maximum);
  if (!result) throw new Error("INVALID_GOOGLE_RESOURCE");
  return result;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("INVALID_GOOGLE_RESOURCE");
  return value;
}

function mapDateTime(value: unknown): GoogleDateTime | undefined {
  if (value === undefined) return undefined;
  if (!isGoogleJsonObject(value)) throw new Error("INVALID_GOOGLE_RESOURCE");
  const date = optionalString(value.date, 32);
  const dateTime = optionalString(value.dateTime, 64);
  const timeZone = optionalString(value.timeZone, 128);
  if (date === undefined && dateTime === undefined) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  return { date, dateTime, timeZone };
}

function mapPerson(value: unknown): GooglePerson | undefined {
  if (value === undefined) return undefined;
  if (!isGoogleJsonObject(value)) throw new Error("INVALID_GOOGLE_RESOURCE");
  const email = optionalString(value.email, 320);
  const displayName = optionalString(value.displayName);
  const self = optionalBoolean(value.self);
  return email === undefined && displayName === undefined && self === undefined
    ? undefined
    : { email, displayName, self };
}

function mapExtendedProperties(
  value: unknown,
): GoogleExtendedProperties | undefined {
  if (value === undefined) return undefined;
  if (!isGoogleJsonObject(value) || Object.keys(value).length > 8) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  if (value.private === undefined) return undefined;
  if (!isGoogleJsonObject(value.private)) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  const entries = Object.entries(value.private);
  if (entries.length > MAX_EXTENDED_PROPERTY_COUNT) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  for (const [key, propertyValue] of entries) {
    if (
      key.length === 0 ||
      key.length > MAX_EXTENDED_PROPERTY_KEY_LENGTH ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      typeof propertyValue !== "string" ||
      propertyValue.length > MAX_EXTENDED_PROPERTY_VALUE_LENGTH
    ) {
      throw new Error("INVALID_GOOGLE_RESOURCE");
    }
  }
  const qaliOperationId = value.private.qaliOperationId;
  if (qaliOperationId === undefined) return undefined;
  if (
    typeof qaliOperationId !== "string" ||
    !OPERATION_ID.test(qaliOperationId)
  ) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  return { private: { qaliOperationId } };
}

function mapConferenceCreateRequest(
  value: unknown,
): GoogleConferenceCreateRequest | undefined {
  if (value === undefined) return undefined;
  if (!isGoogleJsonObject(value) || Object.keys(value).length > 8) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  const requestId = optionalString(value.requestId, 1_024);
  if (requestId !== undefined && requestId.length === 0) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  let status: GoogleConferenceCreateRequest["status"];
  if (value.status !== undefined) {
    if (
      !isGoogleJsonObject(value.status) ||
      Object.keys(value.status).length > 4
    ) {
      throw new Error("INVALID_GOOGLE_RESOURCE");
    }
    const statusCode = value.status.statusCode;
    if (
      statusCode !== "pending" &&
      statusCode !== "success" &&
      statusCode !== "failure"
    ) {
      throw new Error("INVALID_GOOGLE_RESOURCE");
    }
    status = statusCode;
  }
  return requestId === undefined && status === undefined
    ? undefined
    : { requestId, status };
}

export function mapGoogleAttendees(
  value: unknown,
): GoogleAttendee[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  return value.map((entry) => {
    if (!isGoogleJsonObject(entry)) throw new Error("INVALID_GOOGLE_RESOURCE");
    const additionalGuests = entry.additionalGuests;
    if (
      additionalGuests !== undefined &&
      (!Number.isSafeInteger(additionalGuests) ||
        (additionalGuests as number) < 0)
    ) {
      throw new Error("INVALID_GOOGLE_RESOURCE");
    }
    return {
      id: optionalString(entry.id, 256),
      email: optionalString(entry.email, 320),
      displayName: optionalString(entry.displayName),
      responseStatus: optionalString(entry.responseStatus, 32),
      organizer: optionalBoolean(entry.organizer),
      self: optionalBoolean(entry.self),
      optional: optionalBoolean(entry.optional),
      comment: optionalString(entry.comment),
      additionalGuests: additionalGuests as number | undefined,
      resource: optionalBoolean(entry.resource),
    };
  });
}

function parseInstant(value: GoogleDateTime | undefined): number | undefined {
  const source = value?.dateTime ?? value?.date;
  if (source === undefined) return undefined;
  const result = Date.parse(source);
  if (!Number.isFinite(result)) throw new Error("INVALID_GOOGLE_RESOURCE");
  return result;
}

export function mapGoogleCalendar(value: unknown): GoogleCalendar {
  if (!isGoogleJsonObject(value)) throw new Error("INVALID_GOOGLE_RESOURCE");
  const accessRole = optionalString(value.accessRole, 32);
  return {
    id: requiredString(value.id),
    summary: optionalString(value.summary),
    summaryOverride: optionalString(value.summaryOverride),
    backgroundColor: optionalString(value.backgroundColor, 32),
    foregroundColor: optionalString(value.foregroundColor, 32),
    primary: optionalBoolean(value.primary),
    accessRole,
    timeZone: optionalString(value.timeZone, 128),
    selected: optionalBoolean(value.selected),
    hidden: optionalBoolean(value.hidden),
    writable: WRITABLE_ACCESS_ROLES.has(accessRole ?? ""),
  };
}

export function mapGoogleEvent(
  value: unknown,
  calendarId: string,
): GoogleEvent {
  if (!isGoogleJsonObject(value)) throw new Error("INVALID_GOOGLE_RESOURCE");
  const start = mapDateTime(value.start);
  const end = mapDateTime(value.end);
  const status = optionalString(value.status, 32) ?? "confirmed";
  if (status !== "cancelled" && (start === undefined || end === undefined)) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  const updated = optionalString(value.updated, 64);
  const updatedMs = updated === undefined ? undefined : Date.parse(updated);
  if (updatedMs !== undefined && !Number.isFinite(updatedMs)) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  const recurrence = value.recurrence;
  if (
    recurrence !== undefined &&
    (!Array.isArray(recurrence) ||
      recurrence.length > 100 ||
      recurrence.some(
        (line) => typeof line !== "string" || line.length > MAX_TEXT_LENGTH,
      ))
  ) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  if (
    value.conferenceData !== undefined &&
    !isGoogleJsonObject(value.conferenceData)
  ) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  const conference = value.conferenceData as GoogleJsonObject | undefined;
  if (
    conference?.entryPoints !== undefined &&
    !Array.isArray(conference.entryPoints)
  ) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  const entryPoints = (conference?.entryPoints as unknown[] | undefined) ?? [];
  const video = entryPoints.find(
    (entry) =>
      isGoogleJsonObject(entry) &&
      entry.entryPointType === "video" &&
      typeof entry.uri === "string",
  ) as GoogleJsonObject | undefined;
  if (
    conference?.conferenceSolution !== undefined &&
    !isGoogleJsonObject(conference.conferenceSolution)
  ) {
    throw new Error("INVALID_GOOGLE_RESOURCE");
  }
  const solution = conference?.conferenceSolution as
    GoogleJsonObject | undefined;
  const solutionKey = isGoogleJsonObject(solution?.key)
    ? solution.key
    : undefined;
  const hangoutLink = optionalString(value.hangoutLink, 2_048);
  const conferenceUrl = optionalString(video?.uri, 2_048) ?? hangoutLink;
  const originalStartTime = mapDateTime(value.originalStartTime);
  const extendedProperties = mapExtendedProperties(value.extendedProperties);
  const conferenceCreateRequest = mapConferenceCreateRequest(
    conference?.createRequest,
  );

  return {
    id: requiredString(value.id),
    calendarId,
    etag: optionalString(value.etag, 2_048),
    summary: optionalString(value.summary),
    description: optionalString(value.description),
    location: optionalString(value.location),
    startMs: parseInstant(start),
    endMs: parseInstant(end),
    allDay: start === undefined ? undefined : start.date !== undefined,
    start,
    end,
    status,
    updatedMs,
    htmlLink: optionalString(value.htmlLink, 2_048),
    colorId: optionalString(value.colorId, 64),
    visibility: optionalString(value.visibility, 64),
    transparency: optionalString(value.transparency, 64),
    attendees: mapGoogleAttendees(value.attendees),
    attendeesOmitted: optionalBoolean(value.attendeesOmitted),
    organizer: mapPerson(value.organizer),
    creator: mapPerson(value.creator),
    guestsCanModify: optionalBoolean(value.guestsCanModify),
    guestsCanInviteOthers: optionalBoolean(value.guestsCanInviteOthers),
    guestsCanSeeOtherGuests: optionalBoolean(value.guestsCanSeeOtherGuests),
    locked: optionalBoolean(value.locked),
    eventType: optionalString(value.eventType, 64),
    recurrence: recurrence as string[] | undefined,
    recurringEventId: optionalString(value.recurringEventId),
    originalStartTime,
    hangoutLink,
    conferenceUrl,
    conferenceName: optionalString(solution?.name, 256),
    conferenceType: optionalString(solutionKey?.type, 128),
    extendedProperties,
    conferenceCreateRequest,
  };
}

function stableOperationDigest(namespace: string, operationId: string): string {
  if (!OPERATION_ID.test(operationId)) throw googleValidationError();
  const input = `${namespace}\0${operationId}`;
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, "0");
    })
    .join("");
}

export function googleEventIdForOperation(operationId: string): string {
  return `qali${stableOperationDigest("google-event", operationId)}`;
}

export function googleConferenceRequestIdForOperation(
  operationId: string,
): string {
  return `qaliconference${stableOperationDigest("google-conference", operationId)}`;
}

export function assertGoogleWriteIdentity(
  operationId: string,
  googleEventId?: string,
  conferenceRequestId?: string,
): void {
  const expectedEventId = googleEventIdForOperation(operationId);
  if (
    (googleEventId !== undefined &&
      (!GOOGLE_EVENT_ID.test(googleEventId) ||
        googleEventId !== expectedEventId)) ||
    (conferenceRequestId !== undefined &&
      conferenceRequestId !==
        googleConferenceRequestIdForOperation(operationId))
  ) {
    throw googleValidationError();
  }
}

function googleTime(
  milliseconds: number,
  allDay: boolean,
  timeZone?: string,
): GoogleDateTime {
  if (!Number.isFinite(milliseconds)) throw googleValidationError();
  return allDay
    ? { date: new Date(milliseconds).toISOString().slice(0, 10) }
    : { dateTime: new Date(milliseconds).toISOString(), timeZone };
}

export function mapGoogleEventWrite(write: GoogleEventWrite): GoogleJsonObject {
  const hasStart = write.startMs !== undefined;
  const hasEnd = write.endMs !== undefined;
  if (hasStart !== hasEnd) throw googleValidationError();
  if (
    hasStart &&
    (!(write.startMs! < write.endMs!) || typeof write.allDay !== "boolean")
  ) {
    throw googleValidationError();
  }
  if (
    write.attendees !== undefined &&
    (write.attendees.length > 500 ||
      write.attendees.some(
        (attendee) =>
          attendee.email !== undefined && attendee.email.length > 320,
      ))
  ) {
    throw googleValidationError();
  }
  return {
    ...(write.summary !== undefined ? { summary: write.summary } : {}),
    ...(write.description !== undefined
      ? { description: write.description }
      : {}),
    ...(write.location !== undefined ? { location: write.location } : {}),
    ...(hasStart
      ? {
          start: googleTime(write.startMs!, write.allDay!, write.timeZone),
          end: googleTime(write.endMs!, write.allDay!, write.timeZone),
        }
      : {}),
    ...(write.colorId !== undefined ? { colorId: write.colorId } : {}),
    ...(write.visibility !== undefined ? { visibility: write.visibility } : {}),
    ...(write.transparency !== undefined
      ? { transparency: write.transparency }
      : {}),
    ...(write.attendees !== undefined
      ? { attendees: write.attendees.map((attendee) => ({ ...attendee })) }
      : {}),
    ...(write.recurrence !== undefined
      ? { recurrence: [...write.recurrence] }
      : {}),
  };
}
