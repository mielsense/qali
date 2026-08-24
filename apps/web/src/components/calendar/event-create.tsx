import { api } from "@qali/backend/convex/_generated/api";
import type { EventCapabilities } from "@qali/domain/permissions";
import { Button } from "@qali/ui/components/button";
import { Spinner } from "@qali/ui/components/spinner";
import { useAction, useQuery } from "convex/react";
import { useRef, useState } from "react";

import { notify } from "@/lib/notices";
import { useQaliSettings } from "@/components/settings/settings-provider";
import { useDock } from "@/components/workspace/dock-context";

import {
  EventForm,
  isEventFormValid,
  toEventTimes,
  type EventFormValue,
} from "./event-form";
import { claimEventCreateSubmission } from "./event-create-submission";
import { resolveCreateCalendarId } from "./create-calendar-selection";
import { toRRule } from "./rrule";
import type { CivilDate, ZonedCalendarClock } from "./zoned-calendar-clock";

export type CalendarDraftResolution =
  | Readonly<{ kind: "exact"; instantMs: number }>
  | Readonly<{
      kind: "gap-shifted";
      instantMs: number;
      originalMinute: number;
    }>
  | Readonly<{ kind: "ambiguous"; earlierMs: number; laterMs: number }>;

/** Resolve a new timed draft in the configured primary-zone civil clock. */
export function newEventDefaults({
  civilDate,
  minute,
  clock,
}: {
  civilDate: CivilDate;
  minute: number;
  clock: ZonedCalendarClock;
}): Readonly<{
  timeZone: string;
  resolution: CalendarDraftResolution["kind"];
  draftResolution: CalendarDraftResolution;
  requiresConfirmation: boolean;
}> {
  const rejected = clock.wallTimeToInstant(civilDate, minute, "reject");
  const draftResolution: CalendarDraftResolution =
    rejected.kind !== "rejected"
      ? { kind: "exact", instantMs: rejected.instantMs }
      : rejected.reason === "gap"
        ? (() => {
            const shifted = clock.wallTimeToInstant(civilDate, minute, "compatible");
            if (shifted.kind === "rejected") throw new RangeError("Gap cannot resolve");
            return {
              kind: "gap-shifted" as const,
              instantMs: shifted.instantMs,
              originalMinute: minute,
            };
          })()
        : {
            kind: "ambiguous" as const,
            earlierMs: rejected.candidates[0]!.instantMs,
            laterMs: rejected.candidates[1]!.instantMs,
          };
  return {
    timeZone: clock.primaryTimeZone,
    resolution: draftResolution.kind,
    draftResolution,
    requiresConfirmation: draftResolution.kind !== "exact",
  };
}

/** A new event has no owner to answer to yet, so every control is live. */
const FULL_CAPABILITIES: EventCapabilities = {
  canEdit: true,
  canInviteOthers: true,
  canSeeGuests: true,
  canDelete: true,
  canRemoveSelf: false,
  canRespond: false,
  canChangeRecurrence: true,
  isOrganizer: true,
};

/** Fields a duplicate carries over from the event it was copied from. The times
 * are not among them — those ride on the dock's create view, so the ghost on
 * the grid keeps following them. */
export type EventPrefill = Partial<
  Omit<EventFormValue, "startMs" | "endMs" | "recurrence">
>;

export function EventCreate({
  startMs,
  endMs,
  prefill,
  onChangeRange,
  onCancel,
  onCreated,
}: {
  startMs: number;
  endMs: number;
  prefill?: EventPrefill;
  /** Lifts edited times back to the dock so the ghost on the grid follows along. */
  onChangeRange: (startMs: number, endMs: number) => void;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const createEvent = useAction(api.calendar.createEvent);
  const { view } = useDock();
  const { snapshot } = useQaliSettings();
  const primaryTimeZone = snapshot.settings.calendar.primaryTimeZone;
  const defaultCalendarId = snapshot.settings.calendar.defaultCalendarId;
  const calendars = useQuery(api.calendar.listCalendars) ?? [];
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // Idempotency key for this create intent: minted once and reused across retries
  // (a lost response / re-submit) so the backend dedupes to one Google event
  // instead of creating a duplicate. Cleared only on success. See createEvent.
  const operationIdRef = useRef<string | null>(null);
  // Everything but the range. All three "inherit" defaults mean the same thing:
  // no colour override, the primary calendar (resolved server-side when unset),
  // and the calendar's own visibility.
  const [draft, setDraft] = useState<Omit<EventFormValue, "startMs" | "endMs">>({
    summary: "",
    description: "",
    location: "",
    meet: false,
    allDay: false,
    isPrivate: false,
    // Busy is Google's default, so the toggle starts there.
    busy: true,
    colorId: undefined,
    calendarId: undefined,
    guests: [],
    recurrence: null,
    ...prefill,
  });

  // An explicit form choice wins; otherwise honor the durable creation target
  // and fail over to a writable provider primary if that calendar disappeared.
  const activeCalendarId = resolveCreateCalendarId(
    calendars,
    draft.calendarId,
    defaultCalendarId,
  );
  const value: EventFormValue = {
    ...draft,
    calendarId: activeCalendarId,
    startMs,
    endMs,
  };
  const startResolution =
    view?.kind === "create" ? view.startResolution : undefined;
  const endResolution =
    view?.kind === "create" ? view.endResolution : undefined;
  const [confirmedEdges, setConfirmedEdges] = useState({
    start: !startResolution || startResolution.kind === "exact",
    end: !endResolution || endResolution.kind === "exact",
  });
  const resolutionConfirmed = confirmedEdges.start && confirmedEdges.end;
  const valid = isEventFormValid(value) && resolutionConfirmed;

  const confirmEdge = (edge: "start" | "end", instantMs?: number, fold?: "earlier" | "later") => {
    if (instantMs !== undefined) {
      if (edge === "start") {
        const pairedEnd =
          fold &&
          !confirmedEdges.end &&
          endResolution?.kind === "ambiguous" &&
          view?.kind === "create"
            ? fold === "earlier"
              ? (view.foldEndMs?.earlierMs ?? endMs)
              : (view.foldEndMs?.laterMs ?? endMs)
            : endMs;
        onChangeRange(instantMs, pairedEnd);
      } else {
        onChangeRange(startMs, instantMs);
      }
    }
    setConfirmedEdges((current) => ({ ...current, [edge]: true }));
  };

  const onChange = (patch: Partial<EventFormValue>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !claimEventCreateSubmission(submittingRef)) return;
    setSubmitting(true);
    const times = toEventTimes(value);
    if (!operationIdRef.current) {
      operationIdRef.current = crypto.randomUUID();
    }
    createEvent({
      operationId: operationIdRef.current,
      summary: value.summary.trim() || "New event",
      startMs: times.startMs,
      endMs: times.endMs,
      allDay: value.allDay,
      description: value.description || undefined,
      // A video call and a physical location are mutually exclusive modes of
      // the "Where" row, so a Meet event carries no location.
      location: value.meet ? undefined : value.location.trim() || undefined,
      addConference: value.meet || undefined,
      calendarId: activeCalendarId,
      colorId: value.colorId,
      visibility: value.isPrivate ? "private" : undefined,
      // Busy is Google's default; only send the override when Free.
      transparency: value.busy ? undefined : "transparent",
      recurrence: value.recurrence ? toRRule(value.recurrence) : undefined,
      attendees: value.guests.length
        ? value.guests.map((g) => ({
            email: g.email,
            displayName: g.displayName,
          }))
        : undefined,
      timeZone: primaryTimeZone,
    })
      .then(() => {
        operationIdRef.current = null;
        onCreated();
      })
      .catch(() => {
        submittingRef.current = false;
        setSubmitting(false);
        notify({ kind: "event-action-failed", action: "create" });
      });
  };

  return (
    <EventForm
      value={value}
      onChange={onChange}
      onChangeRange={onChangeRange}
      onSubmit={submit}
      primaryTimeZone={primaryTimeZone}
      capabilities={FULL_CAPABILITIES}
      calendars={calendars}
      canChangeCalendar
      autoFocusTitle
      notice={
        !confirmedEdges.start ? (
          <DraftResolutionNotice
            edge="start"
            resolution={startResolution}
            primaryTimeZone={primaryTimeZone}
            onConfirm={confirmEdge}
          />
        ) : !confirmedEdges.end ? (
          <DraftResolutionNotice
            edge="end"
            resolution={endResolution}
            primaryTimeZone={primaryTimeZone}
            onConfirm={confirmEdge}
          />
        ) : undefined
      }
      footer={
        <>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!valid || submitting}>
            {submitting && <Spinner />}
            {submitting ? "Creating…" : "Create"}
          </Button>
        </>
      }
    />
  );
}

function DraftResolutionNotice({
  edge,
  resolution,
  primaryTimeZone,
  onConfirm,
}: {
  edge: "start" | "end";
  resolution: CalendarDraftResolution | undefined;
  primaryTimeZone: string;
  onConfirm: (edge: "start" | "end", instantMs?: number, fold?: "earlier" | "later") => void;
}) {
  const label = edge === "start" ? "start" : "end";
  if (!resolution || resolution.kind === "exact") return null;
  if (resolution.kind === "gap-shifted") {
    return (
      <div role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
        The {label} wall time is shifted forward because it does not occur in {primaryTimeZone}.
        <Button type="button" variant="ghost" size="sm" onClick={() => onConfirm(edge)}>
          Use shifted time
        </Button>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
      The {label} time occurs twice in {primaryTimeZone}.
      <Button type="button" variant="ghost" size="sm" onClick={() => onConfirm(edge, resolution.earlierMs, "earlier")}>
        Earlier
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onConfirm(edge, resolution.laterMs, "later")}>
        Later
      </Button>
    </div>
  );
}
