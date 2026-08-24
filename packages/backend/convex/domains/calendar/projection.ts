import {
  orderCalendarOperations,
  type CalendarEventSnapshot,
  type CalendarOperation,
  type CalendarOperationState,
} from "./operations";

export type { CalendarEventSnapshot, CalendarOperation } from "./operations";

export type ProjectedCalendarEvent = CalendarEventSnapshot &
  Readonly<{ syncState: Exclude<CalendarOperationState, "succeeded" | "cancelled"> | "synced" }>;

export type CalendarConflictGroup =
  | "time"
  | "recurrence"
  | "attendees"
  | "conference"
  | "ownership"
  | string;

const ACTIVE_STATES = new Set<CalendarOperationState>([
  "pending",
  "syncing",
  "conflict",
  "ambiguous",
  "failed",
]);

function applyOperation(
  current: CalendarEventSnapshot | null,
  operation: CalendarOperation,
): CalendarEventSnapshot | null {
  if (operation.kind === "create" && "event" in operation.payload) {
    return { ...operation.payload.event };
  }
  if (current === null) return null;
  if (operation.kind === "update" && "patch" in operation.payload) {
    return { ...current, ...operation.payload.patch } as CalendarEventSnapshot;
  }
  if (operation.kind === "move" && "destinationCalendarId" in operation.payload) {
    return { ...current, calendarId: operation.payload.destinationCalendarId };
  }
  if (operation.kind === "respond" && "responseStatus" in operation.payload) {
    const responseStatus = operation.payload.responseStatus;
    return {
      ...current,
      attendees: current.attendees?.map((attendee) =>
        attendee.self === true
          ? { ...attendee, responseStatus }
          : attendee,
      ),
    };
  }
  if (operation.kind === "delete") return null;
  return current;
}

function projectionState(
  operations: readonly CalendarOperation[],
): ProjectedCalendarEvent["syncState"] {
  if (operations.some((operation) => operation.state === "conflict")) return "conflict";
  if (operations.some((operation) => operation.state === "ambiguous")) return "ambiguous";
  if (operations.some((operation) => operation.state === "failed")) return "failed";
  if (operations.some((operation) => operation.state === "syncing")) return "syncing";
  if (operations.some((operation) => operation.state === "pending")) return "pending";
  return "synced";
}

export function reducePendingOperations(
  baseline: CalendarEventSnapshot | null,
  operations: readonly CalendarOperation[],
): ProjectedCalendarEvent | null {
  const active = orderCalendarOperations(operations).filter((operation) =>
    ACTIVE_STATES.has(operation.state),
  );
  let projection = baseline ? { ...baseline } : null;
  for (const operation of active) projection = applyOperation(projection, operation);
  return projection === null
    ? null
    : ({ ...projection, syncState: projectionState(active) } as ProjectedCalendarEvent);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function conflictGroupFor(field: string): CalendarConflictGroup {
  if (["startMs", "endMs", "allDay", "timeZone"].includes(field)) return "time";
  if (["recurrence", "recurrenceScope", "scope"].includes(field)) return "recurrence";
  if (["attendees", "responseStatus"].includes(field)) return "attendees";
  if (["conference", "conferenceUrl", "conferenceName", "conferenceType", "hangoutLink"].includes(field)) return "conference";
  if (["calendarId", "ownerCalendarId", "destinationCalendarId"].includes(field)) return "ownership";
  return field;
}

function changedGroups(
  before: CalendarEventSnapshot,
  after: CalendarEventSnapshot,
): Set<CalendarConflictGroup> {
  const groups = new Set<CalendarConflictGroup>();
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (["syncState", "remoteEtag", "remoteUpdatedAt"].includes(field)) continue;
    if (!sameValue(before[field], after[field])) groups.add(conflictGroupFor(field));
  }
  return groups;
}

export function operationConflictGroups(
  operation: CalendarOperation,
): Set<CalendarConflictGroup> {
  const groups = new Set<CalendarConflictGroup>();
  if (operation.kind === "create" || operation.kind === "delete") {
    groups.add("ownership");
  } else if (operation.kind === "move") {
    groups.add("ownership");
  } else if (operation.kind === "respond") {
    groups.add("attendees");
  } else if ("patch" in operation.payload) {
    for (const field of Object.keys(operation.payload.patch)) {
      groups.add(conflictGroupFor(field));
    }
  }
  return groups;
}

function localGroups(operations: readonly CalendarOperation[]): Set<CalendarConflictGroup> {
  const groups = new Set<CalendarConflictGroup>();
  for (const operation of operations) {
    if (!ACTIVE_STATES.has(operation.state)) continue;
    for (const group of operationConflictGroups(operation)) groups.add(group);
  }
  return groups;
}

const GROUP_ORDER = ["time", "recurrence", "attendees", "conference", "ownership"];

export function rebaseRemoteSnapshot(
  current: CalendarEventSnapshot,
  incoming: CalendarEventSnapshot,
  operations: readonly CalendarOperation[],
): Readonly<{
  projection: ProjectedCalendarEvent | null;
  conflicts: CalendarConflictGroup[];
}> {
  const remote = changedGroups(current, incoming);
  const local = localGroups(operations);
  const conflicts = [...remote]
    .filter((group) => local.has(group))
    .sort((left, right) => {
      const leftIndex = GROUP_ORDER.indexOf(left);
      const rightIndex = GROUP_ORDER.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? GROUP_ORDER.length : leftIndex) -
          (rightIndex === -1 ? GROUP_ORDER.length : rightIndex);
      }
      return left.localeCompare(right);
    });
  const reduced = reducePendingOperations(incoming, operations);
  return {
    projection:
      reduced && conflicts.length > 0
        ? { ...reduced, syncState: "conflict" }
        : reduced,
    conflicts,
  };
}
