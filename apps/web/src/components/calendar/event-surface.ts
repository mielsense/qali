import {
  ALLDAY_BAND_PADDING,
  ALLDAY_EVENT_GAP,
  ALLDAY_EVENT_HEIGHT,
} from "./lib";
import { EVENT_SURFACE_GUTTERS } from "./event-surface-geometry";

export type EventSurfaceVariant = "timed" | "all-day";

export type EventSurfaceState =
  | "idle"
  | "hover"
  | "focus"
  | "dragging"
  | "disabled"
  | "conflict"
  | "read-only";

export { EVENT_SURFACE_GUTTERS } from "./event-surface-geometry";

const SURFACE_STATE_CONTRAST: Record<
  EventSurfaceState,
  { fillPercent: number; edgePercent: number }
> = {
  idle: { fillPercent: 30, edgePercent: 50 },
  hover: { fillPercent: 34, edgePercent: 58 },
  focus: { fillPercent: 34, edgePercent: 64 },
  dragging: { fillPercent: 38, edgePercent: 70 },
  disabled: { fillPercent: 22, edgePercent: 36 },
  conflict: { fillPercent: 38, edgePercent: 70 },
  "read-only": { fillPercent: 32, edgePercent: 56 },
};

export interface EventSurfacePresentation {
  className: string;
  radiusPx: 8 | 10;
  fillPercent: number;
  edgePercent: number;
  backgroundColor: string;
  borderColor: string;
  boxShadow: string;
  color: string;
  hoverTransform: "none";
}

/** Resolve the shared visual state from actual event interaction and overlap
 * signals. Drag feedback takes precedence so direct manipulation remains clear. */
export function eventSurfaceState({
  canEdit,
  hasConflict,
  isDragging = false,
}: {
  canEdit: boolean;
  hasConflict: boolean;
  isDragging?: boolean;
}): EventSurfaceState {
  if (isDragging) return "dragging";
  if (hasConflict) return "conflict";
  return canEdit ? "idle" : "read-only";
}

/** Native button-equivalent keyboard activation for the timed drag surface. */
export function eventSurfaceActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}

/**
 * The single visual contract shared by timed and all-day calendar events.
 * Layout owners place the event; this primitive owns only the rendered material
 * and state contrast, ensuring the two event variants cannot drift apart.
 */
export function eventSurfacePresentation({
  colorVar,
  variant,
  state = "idle",
}: {
  colorVar: string;
  variant: EventSurfaceVariant;
  state?: EventSurfaceState;
}): EventSurfacePresentation {
  const { fillPercent, edgePercent } = SURFACE_STATE_CONTRAST[state];
  return {
    className: "event-surface border transition-[background-color,border-color] duration-100",
    radiusPx: variant === "timed" ? 10 : 8,
    fillPercent,
    edgePercent,
    backgroundColor: `color-mix(in oklab, var(${colorVar}) ${fillPercent}%, var(--card))`,
    borderColor: `color-mix(in oklab, var(${colorVar}) ${edgePercent}%, var(--border))`,
    boxShadow:
      "inset 0 1px 0 color-mix(in oklab, white 42%, transparent)",
    color: "var(--foreground)",
    hoverTransform: "none",
  };
}

/** All-day lane geometry is fixed per lane so cards retain their rows while a
 * buffered day strip recenters or the visible range changes. */
export function allDaySurfacePosition(lane: number): {
  topPx: number;
  heightPx: number;
} {
  return {
    topPx:
      EVENT_SURFACE_GUTTERS.verticalPx +
      lane * (ALLDAY_EVENT_HEIGHT + ALLDAY_EVENT_GAP),
    heightPx:
      ALLDAY_EVENT_HEIGHT +
      ALLDAY_BAND_PADDING * 2 -
      EVENT_SURFACE_GUTTERS.verticalPx * 2,
  };
}
