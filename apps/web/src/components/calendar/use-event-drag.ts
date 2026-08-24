import { api } from "@qali/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { format } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useDock } from "@/components/workspace/dock-context";
import { notify } from "@/lib/notices";

import { type CalendarEvent, editableEventId, SNAP_MS } from "./lib";
import { useEventCapabilities } from "./permissions";
import type { CalendarTimeRange } from "./preferences";
import { droppableInstantForMinute } from "./time-gutter";
import {
  createZonedCalendarClock,
  parseCivilDate,
  type CivilDate,
  type ZonedCalendarClock,
} from "./zoned-calendar-clock";

/** How a card is being manipulated: relocated whole, or one edge dragged. */
export type DragMode = "move" | "resize-start" | "resize-end";

/** Pixels the pointer must travel before a press becomes a drag (below this a
 * press on a card is treated as a plain tap that opens it). */
const DRAG_THRESHOLD_PX = 4;

/** How long an optimistic override lingers after commit before we give up
 * waiting for the synced row to catch up and drop it anyway. */
const PENDING_TIMEOUT_MS = 10_000;

interface OverrideTimes {
  startMs: number;
  endMs: number;
}

/** Live, non-rendering state for the in-flight gesture. */
interface DragSession {
  event: CalendarEvent;
  mode: DragMode;
  gridEl: HTMLElement;
  el: HTMLElement;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  /** Civil minutes from the card's top edge to the pointer (move only). */
  grabOffsetMinutes: number;
  durationMs: number;
  /** Fold identity of the event's original primary-zone start. */
  startFold: 0 | 1;
  /** Fold identity of the event's original primary-zone end. */
  endFold: 0 | 1;
  moved: boolean;
  /** Set when the event can't be rescheduled. The session still runs so a tap
   * opens the event; only the movement is suppressed. */
  readOnly: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export function moveStartForCivilMinute({
  clock,
  date,
  minute,
  preferredFold,
  durationMs,
  visibleStartMs,
  visibleEndMs,
}: {
  clock: ZonedCalendarClock;
  date: CivilDate;
  minute: number;
  preferredFold: 0 | 1;
  durationMs: number;
  visibleStartMs: number;
  visibleEndMs: number;
}): number | null {
  const resolved = droppableInstantForMinute({
    clock,
    date,
    minute,
    preferredFold,
  });
  if (resolved === null) return null;
  return clamp(
    resolved,
    visibleStartMs,
    Math.max(visibleStartMs, visibleEndMs - durationMs),
  );
}

/** Resolve a drag at an overlap deliberately; callers must name the fold. */
export function resolveDraggedWallTime({
  clock,
  civilDate,
  minute,
  fold,
}: {
  clock: ZonedCalendarClock;
  civilDate: CivilDate;
  minute: number;
  fold: "earlier" | "later";
}): Readonly<{ instantMs: number; offsetMinutes: number; fold: 0 | 1 }> {
  const resolved = clock.wallTimeToInstant(civilDate, minute, fold);
  if (resolved.kind === "rejected") {
    throw new RangeError(`Unable to resolve ${fold} drag wall time`);
  }
  return {
    instantMs: resolved.instantMs,
    offsetMinutes: resolved.offsetMinutes,
    fold: resolved.fold,
  };
}

/** Resolve a resize at the fold belonging to the edge under the pointer. */
export function resolveResizeWallTime({
  clock,
  civilDate,
  minute,
  edgeFold,
}: {
  clock: ZonedCalendarClock;
  civilDate: CivilDate;
  minute: number;
  edgeFold: 0 | 1;
}): Readonly<{ instantMs: number; offsetMinutes: number; fold: 0 | 1 }> {
  const resolved = clock.wallTimeToInstant(
    civilDate,
    minute,
    edgeFold === 1 ? "later" : "earlier",
  );
  if (resolved.kind === "rejected") throw new RangeError("Resize wall time rejected");
  return {
    instantMs: resolved.instantMs,
    offsetMinutes: resolved.offsetMinutes,
    fold: resolved.fold,
  };
}

const SNAP_MINUTES = SNAP_MS / 60_000;
const snapMinute = (minute: number) =>
  Math.round(minute / SNAP_MINUTES) * SNAP_MINUTES;

interface UseEventDrag {
  /** `events` with any live-drag or pending-save overrides applied. */
  effectiveEvents: CalendarEvent[];
  /** Start a drag from a card's pointerdown. `gridEl` is the `data-time-grid`. */
  beginDrag: (
    event: CalendarEvent,
    mode: DragMode,
    e: React.PointerEvent,
    gridEl: HTMLElement | null,
  ) => void;
  /** Id of the card currently being dragged, or null. */
  draggingId: string | null;
}

/**
 * Direct-manipulation drag/resize for timed event cards. A card reports its
 * pointerdown here; this tracks the pointer against the shared time-grid
 * geometry (so a move can cross day columns), snaps to the 15-minute grid, and
 * on drop persists via `updateEventTime`. Both the live preview and the
 * post-save hold are expressed as overrides on the events array, so the real
 * card re-lays-out and physically relocates with no bespoke positioning.
 *
 * Events the user may not reschedule still start a session — a tap has to keep
 * opening them — but never move. Refusing at pointerdown instead would make a
 * holiday feel dead to the touch.
 */
export function useEventDrag(
  events: CalendarEvent[],
  days: Date[],
  primaryTimeZone: string,
  timeRange: CalendarTimeRange,
): UseEventDrag {
  const { open } = useDock();
  const updateEventTime = useAction(api.calendar.updateEventTime);
  const capabilitiesOf = useEventCapabilities();
  const clock = useMemo(
    () => createZonedCalendarClock(primaryTimeZone),
    [primaryTimeZone],
  );

  const [overrides, setOverrides] = useState<Record<string, OverrideTimes>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sessionRef = useRef<DragSession | null>(null);
  // Latest `days` for the move handler without re-binding window listeners.
  const daysRef = useRef(days);
  daysRef.current = days;
  // Ids whose override is a committed save awaiting the synced row (vs. a live
  // drag). Reconciled against incoming `events`.
  const pendingRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const effectiveEvents = useMemo(() => {
    if (Object.keys(overrides).length === 0) return events;
    return events.map((event) => {
      const o = overrides[event._id];
      return o ? { ...event, startMs: o.startMs, endMs: o.endMs } : event;
    });
  }, [events, overrides]);

  // Drop a pending override once the synced row reflects its times (or the row
  // vanished). Live-drag overrides (the active card) are left alone.
  useEffect(() => {
    if (pendingRef.current.size === 0) return;
    const byId = new Map<string, CalendarEvent>(events.map((e) => [e._id, e]));
    setOverrides((prev) => {
      let next = prev;
      for (const id of pendingRef.current) {
        const row = byId.get(id);
        const o = prev[id];
        if (!o) {
          pendingRef.current.delete(id);
          continue;
        }
        if (!row || (row.startMs === o.startMs && row.endMs === o.endMs)) {
          if (next === prev) next = { ...prev };
          delete next[id];
          pendingRef.current.delete(id);
          const t = timersRef.current.get(id);
          if (t) {
            clearTimeout(t);
            timersRef.current.delete(id);
          }
        }
      }
      return next;
    });
  }, [events]);

  // Clear any lingering timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const endSession = useCallback(() => {
    const s = sessionRef.current;
    if (s) {
      try {
        s.el.releasePointerCapture(s.pointerId);
      } catch {
        // Capture may never have been taken (tap) — ignore.
      }
    }
    sessionRef.current = null;
    setDraggingId(null);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerCancel = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      setOverrides((prev) => {
        if (!prev[s.event._id]) return prev;
        const next = { ...prev };
        delete next[s.event._id];
        return next;
      });
      endSession();
    },
    [endSession],
  );

  /** Compute the proposed times for the current pointer position. */
  const computeTimes = useCallback(
    (
      s: DragSession,
      clientX: number,
      clientY: number,
    ): OverrideTimes | null => {
      const rect = s.gridEl.getBoundingClientRect();
      const height = rect.height || 1;
      const origStart = s.event.startMs;
      const rangeMinutes = (timeRange.endHour - timeRange.startHour) * 60;
      const pointerMinute =
        timeRange.startHour * 60 +
        ((clientY - rect.top) / height) * rangeMinutes;

      if (s.mode === "move") {
        const cols = daysRef.current.length;
        const colWidth = rect.width / cols;
        const idx = clamp(
          Math.floor((clientX - rect.left) / colWidth),
          0,
          cols - 1,
        );
        const date = parseCivilDate(format(daysRef.current[idx], "yyyy-MM-dd"));
        const day = clock.day(date);
        const visibleStart =
          droppableInstantForMinute({
            clock,
            date,
            minute: timeRange.startHour * 60,
          }) ?? day.startMs;
        const visibleEnd =
          timeRange.endHour === 24
            ? day.endMs
            : (droppableInstantForMinute({
                clock,
                date,
                minute: timeRange.endHour * 60,
              }) ?? day.endMs);
        const minute = clamp(
          snapMinute(pointerMinute - s.grabOffsetMinutes),
          timeRange.startHour * 60,
          timeRange.endHour * 60 - SNAP_MINUTES,
        );
        const startMs = moveStartForCivilMinute({
          clock,
          date,
          minute,
          preferredFold: s.startFold,
          durationMs: s.durationMs,
          visibleStartMs: visibleStart,
          visibleEndMs: visibleEnd,
        });
        if (startMs === null) return null;
        return { startMs, endMs: startMs + s.durationMs };
      }

      const edgeMs = s.mode === "resize-end" ? s.event.endMs : origStart;
      const eventWall = clock.instantToWallTime(edgeMs);
      const day = clock.day(eventWall.date);
      const minute = clamp(
        snapMinute(pointerMinute),
        timeRange.startHour * 60,
        timeRange.endHour * 60,
      );
      const pointer =
        minute >= 24 * 60
          ? day.endMs
          : droppableInstantForMinute({
              clock,
              date: eventWall.date,
              minute,
              preferredFold: s.mode === "resize-end" ? s.endFold : s.startFold,
            });
      if (pointer === null) return null;
      if (s.mode === "resize-start") {
        const startMs = Math.min(pointer, s.event.endMs - SNAP_MS);
        return { startMs, endMs: s.event.endMs };
      }
      const endMs = Math.max(pointer, origStart + SNAP_MS);
      return { startMs: origStart, endMs };
    },
    [clock, timeRange.endHour, timeRange.startHour],
  );

  const commit = useCallback(
    (id: string, times: OverrideTimes) => {
      pendingRef.current.add(id);
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      timersRef.current.set(
        id,
        setTimeout(() => {
          pendingRef.current.delete(id);
          timersRef.current.delete(id);
          setOverrides((prev) => {
            if (!prev[id]) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, PENDING_TIMEOUT_MS),
      );
      updateEventTime({
        eventId: editableEventId(id),
        startMs: times.startMs,
        endMs: times.endMs,
        timeZone: primaryTimeZone,
      }).catch(() => {
        // Roll the card back to its synced position and surface the failure.
        pendingRef.current.delete(id);
        const t = timersRef.current.get(id);
        if (t) {
          clearTimeout(t);
          timersRef.current.delete(id);
        }
        setOverrides((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
        notify({ kind: "event-action-failed", action: "reschedule" });
      });
    },
    [primaryTimeZone, updateEventTime],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      // Never promote the press to a drag: pointerup then always takes the
      // tap path below and opens the event.
      if (s.readOnly) return;
      if (!s.moved) {
        if (
          Math.abs(e.clientX - s.startClientX) < DRAG_THRESHOLD_PX &&
          Math.abs(e.clientY - s.startClientY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        s.moved = true;
        try {
          s.el.setPointerCapture(s.pointerId);
        } catch {
          // Non-fatal: window listeners still deliver moves.
        }
        setDraggingId(s.event._id);
      }
      const times = computeTimes(s, e.clientX, e.clientY);
      if (!times) return;
      setOverrides((prev) => ({ ...prev, [s.event._id]: times }));
    },
    [computeTimes],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s || e.pointerId !== s.pointerId) return;
      if (!s.moved) {
        // A press that never became a drag — anywhere on the card, edges
        // included — opens the event.
        open({ kind: "event", event: s.event });
        endSession();
        return;
      }
      const times = computeTimes(s, e.clientX, e.clientY);
      if (!times) {
        endSession();
        return;
      }
      const id = s.event._id;
      const unchanged =
        times.startMs === s.event.startMs && times.endMs === s.event.endMs;
      if (unchanged) {
        setOverrides((prev) => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      } else {
        setOverrides((prev) => ({ ...prev, [id]: times }));
        commit(id, times);
      }
      endSession();
    },
    [computeTimes, commit, open, endSession],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const s = sessionRef.current;
      if (!s) return;
      setOverrides((prev) => {
        if (!prev[s.event._id]) return prev;
        const next = { ...prev };
        delete next[s.event._id];
        return next;
      });
      endSession();
    },
    [endSession],
  );

  const beginDrag = useCallback(
    (
      event: CalendarEvent,
      mode: DragMode,
      e: React.PointerEvent,
      gridEl: HTMLElement | null,
    ) => {
      if (e.button !== 0 || !gridEl) return;
      const cardRect = e.currentTarget.getBoundingClientRect();
      const gridRect = gridEl.getBoundingClientRect();
      const rangeMinutes = (timeRange.endHour - timeRange.startHour) * 60;
      sessionRef.current = {
        event,
        mode,
        gridEl,
        el: e.currentTarget as HTMLElement,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        grabOffsetMinutes:
          ((e.clientY - cardRect.top) / (gridRect.height || 1)) * rangeMinutes,
        durationMs: Math.max(event.endMs - event.startMs, SNAP_MS),
        startFold: clock.instantToWallTime(event.startMs).fold,
        endFold: clock.instantToWallTime(event.endMs).fold,
        moved: false,
        readOnly: !capabilitiesOf(event).canEdit,
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown);
    },
    [
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onKeyDown,
      capabilitiesOf,
      clock,
      timeRange.endHour,
      timeRange.startHour,
    ],
  );

  return { effectiveEvents, beginDrag, draggingId };
}
