export type GoogleCalendarErrorKind =
  | "auth"
  | "rate-limit"
  | "conflict"
  | "validation"
  | "network"
  | "ambiguous"
  | "remote";

export type GoogleSendUpdates = "all" | "externalOnly" | "none";

export type GoogleCalendar = Readonly<{
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
}>;

export type GoogleDateTime = Readonly<{
  date?: string;
  dateTime?: string;
  timeZone?: string;
}>;

export type GooglePerson = Readonly<{
  email?: string;
  displayName?: string;
  self?: boolean;
}>;

export type GoogleAttendee = Readonly<{
  id?: string;
  email?: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
  comment?: string;
  additionalGuests?: number;
  resource?: boolean;
}>;

export type GoogleExtendedProperties = Readonly<{
  private?: Readonly<{
    qaliOperationId?: string;
  }>;
}>;

export type GoogleConferenceCreateRequest = Readonly<{
  requestId?: string;
  status?: "pending" | "success" | "failure";
}>;

export type GoogleEvent = Readonly<{
  id: string;
  calendarId: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  status: string;
  updatedMs?: number;
  htmlLink?: string;
  colorId?: string;
  visibility?: string;
  transparency?: string;
  attendees?: readonly GoogleAttendee[];
  attendeesOmitted?: boolean;
  organizer?: GooglePerson;
  creator?: GooglePerson;
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  locked?: boolean;
  eventType?: string;
  recurrence?: readonly string[];
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
  hangoutLink?: string;
  conferenceUrl?: string;
  conferenceName?: string;
  conferenceType?: string;
  extendedProperties?: GoogleExtendedProperties;
  conferenceCreateRequest?: GoogleConferenceCreateRequest;
}>;

export type GoogleEventChanges = Readonly<{
  events: readonly GoogleEvent[];
  nextSyncToken?: string;
}>;

export type GoogleEventWrite = Readonly<{
  summary?: string;
  description?: string | null;
  location?: string | null;
  startMs?: number;
  endMs?: number;
  allDay?: boolean;
  timeZone?: string;
  colorId?: string | null;
  visibility?: string | null;
  transparency?: string;
  attendees?: readonly GoogleAttendee[];
  recurrence?: readonly string[];
  conference?: "add" | "remove";
}>;

export type GoogleWriteIdentity = Readonly<{
  /** Stable Qali operation identity; never a Google credential or session id. */
  id: string;
  /** Last confirmed remote ETag. Omitted only for a create. */
  etag?: string;
  signal: AbortSignal;
}>;

export type GoogleInsertOperation = GoogleWriteIdentity &
  Readonly<{
    googleEventId: string;
    conferenceRequestId: string;
    event: GoogleEventWrite;
    sendUpdates?: GoogleSendUpdates;
  }>;

/** Exact Google primitive target. Task 10 must resolve recurring scope into the
 * instance or master id (and split this-and-following when necessary) before it
 * constructs an adapter operation. Passing a recurrenceScope is rejected. */
export type GoogleResolvedEventTarget = Readonly<{
  calendarId: string;
  eventId: string;
}>;

export type GooglePatchOperation = GoogleWriteIdentity &
  GoogleResolvedEventTarget &
  Readonly<{
    etag: string;
    patch: GoogleEventWrite;
    conferenceRequestId?: string;
    sendUpdates?: GoogleSendUpdates;
  }>;

export type GoogleMoveOperation = GoogleWriteIdentity &
  GoogleResolvedEventTarget &
  Readonly<{
    etag: string;
    destinationCalendarId: string;
    sendUpdates?: GoogleSendUpdates;
  }>;

export type GoogleRespondOperation = GoogleWriteIdentity &
  GoogleResolvedEventTarget &
  Readonly<{
    etag: string;
    responseStatus: "accepted" | "tentative" | "declined";
    sendUpdates?: GoogleSendUpdates;
  }>;

export type GoogleDeleteOperation = GoogleWriteIdentity &
  GoogleResolvedEventTarget &
  Readonly<{
    etag: string;
    sendUpdates?: GoogleSendUpdates;
  }>;

export type GoogleAvailability = Readonly<{
  calendars: Readonly<
    Record<
      string,
      Readonly<{
        busy: readonly Readonly<{ startMs: number; endMs: number }>[];
        errors?: readonly Readonly<{ domain?: string; reason?: string }>[];
      }>
    >
  >;
}>;
