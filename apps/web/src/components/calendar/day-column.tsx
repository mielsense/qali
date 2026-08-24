import { cn } from "@qali/ui/lib/utils";
import { format, isToday } from "date-fns";
import {
  memo,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDock } from "@/components/workspace/dock-context";

import {
  newEventDefaults,
  type CalendarDraftResolution,
} from "./event-create";
import { EventCard } from "./event-card";
import { GhostEvent } from "./ghost-event";
import {
  LANE_TILE_MAX_STAGGER_MS,
  layoutDayEvents,
  SNAP_MS,
  WEEK_LANE_TILE_MAX_STAGGER_MS,
  type CalendarEvent,
} from "./lib";
import {
  type CalendarTimeRange,
  snappedMinuteFromVisibleOffsetY,
} from "./preferences";
import { droppableInstantForMinute, timeGridPlacement } from "./time-gutter";
import type { Reveal } from "./today-pulse";
import type { DragMode } from "./use-event-drag";
import {
  createZonedCalendarClock,
  parseCivilDate,
  type CivilDate,
  type ZonedCalendarClock,
} from "./zoned-calendar-clock";

/** Convert a grid drag's primary-zone civil interval into a draft that keeps
 * both fold candidates available until the create dock obtains a choice. */
export function createGridEventDraft({
  clock,
  civilDate,
  startMinute,
  endMinute,
}: {
  clock: ZonedCalendarClock;
  civilDate: CivilDate;
  startMinute: number;
  endMinute: number;
}): Readonly<{
  startMs: number;
  endMs: number;
  startResolution: CalendarDraftResolution;
  endResolution: CalendarDraftResolution;
  requiresConfirmation: boolean;
  foldEndMs?: Readonly<{ earlierMs: number; laterMs: number }>;
}> {
  const start = newEventDefaults({ clock, civilDate, minute: startMinute });
  const startResolution = start.draftResolution;
  const endResolution: CalendarDraftResolution =
    endMinute >= 24 * 60
      ? { kind: "exact", instantMs: clock.day(civilDate).endMs }
      : newEventDefaults({ clock, civilDate, minute: endMinute }).draftResolution;
  const firstInstant = (resolution: CalendarDraftResolution) =>
    resolution.kind === "ambiguous"
      ? resolution.earlierMs
      : resolution.instantMs;
  const endCandidates =
    endResolution.kind === "ambiguous"
      ? { earlierMs: endResolution.earlierMs, laterMs: endResolution.laterMs }
      : { earlierMs: endResolution.instantMs, laterMs: endResolution.instantMs };
  return {
    startMs: firstInstant(startResolution),
    endMs: endCandidates.earlierMs,
    startResolution,
    endResolution,
    requiresConfirmation:
      startResolution.kind !== "exact" || endResolution.kind !== "exact",
    ...(startResolution.kind === "ambiguous"
      ? { foldEndMs: endCandidates }
      : {}),
  };
}

interface Draft {
  anchorMs: number;
  startMs: number;
  endMs: number;
  status: "armed" | "dragging";
}

const DRAG_THRESHOLD_PX = 4;

interface DayColumnProps {
  day: Date;
  events: CalendarEvent[];
  /** The shared `data-time-grid` element, read by card drags for geometry. */
  gridRef: RefObject<HTMLDivElement | null>;
  /** Start a move/resize gesture from a card. */
  beginDrag: (
    event: CalendarEvent,
    mode: DragMode,
    e: React.PointerEvent,
    gridEl: HTMLElement | null,
  ) => void;
  /** Id of the card currently being dragged, or null. */
  draggingId: string | null;
  /** Split overlaps into side-by-side columns (day view) vs. cascade (week). */
  laneLayout: boolean;
  /** Synced contact photos keyed by lower-cased email. */
  contactPhotos: ReadonlyMap<string, string>;
  /** The active reveal target; pulses the matching event card. */
  reveal: Reveal;
  timeRange: CalendarTimeRange;
  primaryTimeZone: string;
}

function DayColumnImpl({
  day,
  events,
  gridRef,
  beginDrag,
  draggingId,
  laneLayout,
  contactPhotos,
  reveal,
  timeRange,
  primaryTimeZone,
}: DayColumnProps) {
  const clock = useMemo(
    () => createZonedCalendarClock(primaryTimeZone),
    [primaryTimeZone],
  );
  const civilDate = useMemo(
    () => parseCivilDate(format(day, "yyyy-MM-dd")),
    [day],
  );
  const calendarDay = useMemo(() => clock.day(civilDate), [civilDate, clock]);
  const dayStartMs = calendarDay.startMs;
  const dayEndMs = calendarDay.endMs;
  const visibleStartMs =
    droppableInstantForMinute({
      clock,
      date: civilDate,
      minute: timeRange.startHour * 60,
    }) ?? dayStartMs;
  const visibleEndMs =
    timeRange.endHour === 24
      ? dayEndMs
      : (droppableInstantForMinute({
          clock,
          date: civilDate,
          minute: timeRange.endHour * 60,
        }) ?? dayEndMs);
  const { view, open } = useDock();
  const ref = useRef<HTMLDivElement>(null);
  const pressClientY = useRef(0);
  const [draft, setDraft] = useState<Draft | null>(null);

  // A create awaiting confirmation in the dock keeps its ghost on whichever
  // column it falls in, and follows the times as they're edited there.
  const pendingRange =
    view?.kind === "create" &&
    view.startMs < visibleEndMs &&
    view.endMs > visibleStartMs
      ? view
      : null;

  // Week columns cascade and tile more eagerly than the wider day column; the
  // threshold that flips a close-starting overlap from cascade to side-by-side
  // tiles follows the same laneLayout switch used for rendering.
  const tileMaxStaggerMs = laneLayout
    ? LANE_TILE_MAX_STAGGER_MS
    : WEEK_LANE_TILE_MAX_STAGGER_MS;
  const positioned = useMemo(
    () =>
      layoutDayEvents(
        events.filter(
          (event) =>
            event.endMs > visibleStartMs && event.startMs < visibleEndMs,
        ),
        dayStartMs,
        tileMaxStaggerMs,
      ).map((entry) => {
        const start = Math.max(entry.event.startMs, visibleStartMs);
        const end = Math.min(entry.event.endMs, visibleEndMs);
        const placement = timeGridPlacement({
          clock,
          date: civilDate,
          startMs: start,
          endMs: end,
          timeRange,
        });
        return {
          ...entry,
          topPct: placement.topPct,
          heightPct: placement.heightPct,
        };
      }),
    [
      events,
      dayStartMs,
      tileMaxStaggerMs,
      timeRange,
      clock,
      civilDate,
      visibleStartMs,
      visibleEndMs,
    ],
  );

  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft]);

  const snappedMs = (clientY: number): number | null => {
    const rect = ref.current?.getBoundingClientRect();
    const top = rect?.top ?? 0;
    const height = rect?.height ?? 1;
    const minute = snappedMinuteFromVisibleOffsetY(
      clientY - top,
      height,
      timeRange,
    );
    if (minute >= 24 * 60) return dayEndMs;
    return droppableInstantForMinute({ clock, date: civilDate, minute });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-event]")) return;
    const snapped = snappedMs(e.clientY);
    if (snapped === null) return;
    const anchorMs = Math.min(snapped, visibleEndMs - SNAP_MS);
    pressClientY.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({
      anchorMs,
      startMs: anchorMs,
      endMs: anchorMs + SNAP_MS,
      status: "armed",
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draft) return;
    if (
      draft.status === "armed" &&
      Math.abs(e.clientY - pressClientY.current) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    const cursorMs = snappedMs(e.clientY);
    if (cursorMs === null) return;
    const startMs = Math.min(draft.anchorMs, cursorMs);
    const endMs = Math.min(
      Math.max(Math.max(draft.anchorMs, cursorMs), startMs + SNAP_MS),
      visibleEndMs,
    );
    setDraft({ ...draft, startMs, endMs, status: "dragging" });
  };

  const onPointerUp = () => {
    if (!draft) return;
    // A plain click (never crossed the drag threshold) creates nothing.
    if (draft.status === "armed") {
      setDraft(null);
      return;
    }
    const { startMs, endMs } = draft;
    setDraft(null);
    // The drag only proposes a range — the dock takes it from here and
    // the user confirms. Hand the range over and drop the local draft; the ghost
    // that stays on the grid is now driven by the dock's create view.
    const startWall = clock.instantToWallTime(startMs);
    const endWall = clock.instantToWallTime(endMs);
    open({
      kind: "create",
      ...createGridEventDraft({
        clock,
        civilDate,
        startMinute: startWall.minute,
        endMinute: endWall.date === civilDate ? endWall.minute : 24 * 60,
      }),
    });
  };

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={cn(
        "relative border-l border-border last:border-r",
        draft && "touch-none select-none",
      )}
      style={{
        scrollSnapAlign: "start",
        // Subtle tint on today's column (matching the marketing week view) that
        // fades to transparent toward the bottom rather than ending on a hard edge.
        ...(isToday(day) && {
          backgroundImage:
            "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 3%, transparent) 0%, color-mix(in oklab, var(--primary) 3%, transparent) 75%, transparent 100%)",
        }),
      }}
    >
      <div>
        {positioned.map((p) => (
          <EventCard
            key={p.event._id}
            positioned={p}
            isDragging={draggingId === p.event._id}
            laneLayout={laneLayout}
            contactPhotos={contactPhotos}
            reveal={reveal}
            onDragStart={(mode, e) =>
              beginDrag(p.event, mode, e, gridRef.current)
            }
          />
        ))}
      </div>
      {draft && draft.status === "dragging" && (
        <GhostEvent
          startMs={draft.startMs}
          endMs={draft.endMs}
          placement={timeGridPlacement({
            clock,
            date: civilDate,
            startMs: draft.startMs,
            endMs: draft.endMs,
            timeRange,
          })}
          timeZone={primaryTimeZone}
          pending={false}
          wallClock={false}
        />
      )}
      {pendingRange && (
        <GhostEvent
          startMs={pendingRange.startMs}
          endMs={pendingRange.endMs}
          placement={timeGridPlacement({
            clock,
            date: civilDate,
            startMs: pendingRange.startMs,
            endMs: pendingRange.endMs,
            timeRange,
          })}
          timeZone={primaryTimeZone}
          pending
        />
      )}
    </div>
  );
}

/**
 * A strip renders dozens of these at once and scrolling re-renders the strip
 * on every animation frame, so memoization is what keeps a gesture cheap.
 * It only holds while every prop keeps its identity — in particular the
 * `?? []` query fallbacks in time-strip.tsx must stay hoisted to module
 * constants, or each render mints new arrays and this becomes a no-op.
 */
export const DayColumn = memo(DayColumnImpl);
