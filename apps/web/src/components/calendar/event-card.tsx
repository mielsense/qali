import { Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@qali/ui/lib/utils";
import { format } from "date-fns";
import { motion } from "motion/react";

import { Avatar } from "./avatar";
import { useEventColor } from "./colors";
import {
  eventSurfaceActivationKey,
  eventSurfacePresentation,
  eventSurfaceState,
  EVENT_SURFACE_GUTTERS,
} from "./event-surface";
import { eventHorizontalBox, type PositionedEvent } from "./lib";
import { pressTransition } from "./motion";
import { useEventCapabilities } from "./permissions";
import { RevealFlash, type Reveal } from "./today-pulse";
import type { DragMode } from "./use-event-drag";
import { useDock } from "@/components/workspace/dock-context";

interface EventCardProps {
  positioned: PositionedEvent;
  /** True while this card is the one being moved/resized. */
  isDragging: boolean;
  /** Lay overlaps out as side-by-side columns (day view) instead of the cascade
   * (week view), where the column is too narrow to subdivide. */
  laneLayout: boolean;
  /** Synced contact photos keyed by lower-cased email. */
  contactPhotos: ReadonlyMap<string, string>;
  /** The active reveal target; pulses this card when it's the one reached for. */
  reveal: Reveal;
  /** Begin a gesture; the mode is derived from where the press landed. */
  onDragStart: (mode: DragMode, e: React.PointerEvent) => void;
}

/** Pick the gesture from the press target: the edge handles resize, the body
 * moves the whole event. */
function modeForTarget(target: EventTarget | null): DragMode {
  const el = target as HTMLElement | null;
  if (el?.closest("[data-resize-top]")) return "resize-start";
  if (el?.closest("[data-resize-bottom]")) return "resize-end";
  return "move";
}

export function EventCard({
  positioned,
  isDragging,
  laneLayout,
  contactPhotos,
  reveal,
  onDragStart,
}: EventCardProps) {
  const {
    event,
    topPct,
    heightPct,
    stackIndex,
    isConflicting,
    elevation,
    columnIndex,
    columnCount,
    columnSpan,
    laneAdvance,
  } = positioned;
  const colorFor = useEventColor();
  const { open } = useDock();
  const colorVar = colorFor(event);
  // An event the user can't reschedule still opens on tap, but it shouldn't
  // offer a grab cursor or resize edges for a drag that will never happen.
  const { canEdit: draggable, canSeeGuests } = useEventCapabilities()(event);
  const attendees = canSeeGuests ? (event.attendees ?? []).slice(0, 3) : [];
  const surfaceState = eventSurfaceState({
    canEdit: draggable,
    hasConflict: isConflicting,
    isDragging,
  });
  const surface = eventSurfacePresentation({
    colorVar,
    variant: "timed",
    state: surfaceState,
  });
  const hoverSurface = eventSurfacePresentation({
    colorVar,
    variant: "timed",
    state: "hover",
  });
  const focusSurface = eventSurfacePresentation({
    colorVar,
    variant: "timed",
    state: "focus",
  });
  // Two overlap modes. Lanes: each cluster fans into side-by-side lanes that
  // partially overlap, so a card exposes its own left edge while the later card
  // paints on top — spread out, but still visibly stacked. Cascade: each deeper
  // card is indented right with its right edge pinned, so cards behind peek out
  // on the left. Day view always uses lanes; week columns are too narrow to fan
  // and cascade instead — except a cluster whose starts sit too close to stagger
  // cleanly (laneAdvance === 1, see layoutDayEvents) tiles into clean columns in
  // both views, so the later card never buries the earlier one's title/time.
  const horizontal = eventHorizontalBox(
    {
      stackIndex,
      columnIndex,
      columnCount,
      columnSpan,
      laneAdvance,
    },
    laneLayout,
  );
  // The card is a size-query container (see `.event-card` in globals.css): the
  // start time and title shrink out as the rendered height gets small, so short
  // events stay legible instead of clipping the title. This tracks actual
  // pixels, so a short event regains its detail lines when the grid is zoomed.
  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`Open ${event.summary ?? "untitled event"}`}
      data-event
      data-event-surface-state={surfaceState}
      onPointerDown={(e) => onDragStart(modeForTarget(e.target), e)}
      onKeyDown={(e) => {
        if (!eventSurfaceActivationKey(e.key)) return;
        e.preventDefault();
        open({ kind: "event", event });
      }}
      whileTap={isDragging ? undefined : { scale: 0.97 }}
      transition={{ scale: pressTransition }}
      className={cn(
        // A 15-minute event is 20px tall at the grid's minimum zoom. Keep that
        // exact floor so a quarter-hour remains a legible, direct-manipulation
        // target without visually overstating its duration.
        "event-card group absolute min-h-[20px] overflow-hidden select-none",
        surface.className,
        draggable ? "cursor-grab" : "cursor-pointer",
        isDragging && "cursor-grabbing touch-none ring-2 ring-primary/60",
      )}
      style={{
        top: `calc(${topPct}% + ${EVENT_SURFACE_GUTTERS.verticalPx}px)`,
        height: `calc(${heightPct}% - ${EVENT_SURFACE_GUTTERS.verticalPx * 2}px)`,
        left: `calc(${horizontal.leftPct}% + ${horizontal.insetStartPx}px)`,
        width: `calc(${horizontal.widthPct}% - ${horizontal.insetStartPx + horizontal.insetEndPx}px)`,
        zIndex: isDragging ? 50 : 10 + elevation,
        borderRadius: `${surface.radiusPx}px`,
        "--event-surface-background": surface.backgroundColor,
        "--event-surface-border": surface.borderColor,
        "--event-surface-highlight": surface.boxShadow,
        "--event-surface-foreground": surface.color,
        "--event-surface-color": `var(${colorVar})`,
        "--event-surface-hover-fill": `${hoverSurface.fillPercent}%`,
        "--event-surface-hover-edge": `${hoverSurface.edgePercent}%`,
        "--event-surface-focus-fill": `${focusSurface.fillPercent}%`,
        "--event-surface-focus-edge": `${focusSurface.edgePercent}%`,
      } as React.CSSProperties}
    >
      <RevealFlash
        reveal={reveal}
        targetId={[event._id, event.googleEventId]}
        className="rounded-[10px] bg-[color-mix(in_oklab,var(--primary)_45%,transparent)]"
      />
      <div className="event-card-body flex h-full flex-col justify-start px-2 py-1">
        {/* No `text-*`/`leading-*` utilities on these two: the size steps live in
            `.event-card-title` / `.event-card-time` (globals.css), and a utility
            here sits in a later layer and would silently outrank them. */}
        <p className="event-card-title font-medium">
          {event.summary ?? "(No title)"}
        </p>
        <p className="event-card-time truncate text-muted-foreground">
          {`${format(event.startMs, "h:mm")} – ${format(event.endMs, "h:mm a")}`}
        </p>
        {(attendees.length > 0 || event.hangoutLink) && (
          <div className="event-card-meta mt-auto min-w-0 items-center justify-between gap-1 pt-1">
            {attendees.length > 0 && (
              <span className="event-card-attendees flex min-w-0 items-center">
                {attendees.map((attendee) => (
                  <span
                    key={attendee.email}
                    className="event-card-attendee relative -ml-1.5 shrink-0 rounded-full ring-1 ring-background/80 first:ml-0"
                  >
                    <Avatar
                      email={attendee.email}
                      name={attendee.displayName}
                      photoUrl={contactPhotos.get(attendee.email.toLowerCase())}
                      className="size-5 text-[0.625rem]"
                    />
                  </span>
                ))}
              </span>
            )}
            {event.hangoutLink && (
              <span
                role="img"
                aria-label="Google Meet attached"
                className="event-card-meeting ml-auto shrink-0 text-muted-foreground/45"
              >
                <HugeiconsIcon icon={Video01Icon} size={15} strokeWidth={1.8} />
              </span>
            )}
          </div>
        )}
      </div>
      {/* Edge handles for resizing start/end. Invisible until hover so they
          don't clutter the card, but always hit-testable. */}
      {draggable && (
        <>
          <span
            data-resize-top
            aria-hidden
            className="absolute inset-x-0 top-0 h-2 cursor-ns-resize touch-none"
          />
          <span
            data-resize-bottom
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize touch-none"
          />
        </>
      )}
    </motion.div>
  );
}
