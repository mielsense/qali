import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";

import { CommandProvider, useCommand } from "@/commands/command-provider";
import type {
  CalendarDraftResolution,
  EventPrefill,
} from "@/components/calendar/event-create";
import { useQaliSettings } from "@/components/settings/settings-provider";
import {
  DEFAULT_EVENT_DURATION_MS,
  DEFAULT_EVENT_START_MINUTES,
  SNAP_MS,
  type CalendarEvent,
} from "@/components/calendar/lib";
import {
  createZonedCalendarClock,
  parseCivilDate,
} from "@/components/calendar/zoned-calendar-clock";

/** What the dock is currently showing. `null` means the plain nav bar.
 *
 * A create view keeps its range at the top level rather than inside `prefill`,
 * because the ghost on the grid reads those two fields directly. */
export type DockView =
  | { kind: "event"; event: CalendarEvent }
  | { kind: "edit"; event: CalendarEvent }
  | {
      kind: "create";
      startMs: number;
      endMs: number;
      prefill?: EventPrefill;
      startResolution?: CalendarDraftResolution;
      endResolution?: CalendarDraftResolution;
      foldEndMs?: Readonly<{ earlierMs: number; laterMs: number }>;
    }
  | { kind: "account" };

/** Stable key for the content swap — changing it cross-fades the dock's contents.
 * A create view keys on its kind alone, so editing its times re-renders the form
 * in place (and moves the ghost on the grid) instead of replaying the swap. */
export function dockViewId(view: DockView): string {
  if (view.kind === "event") return `event:${view.event._id}`;
  if (view.kind === "edit") return `edit:${view.event._id}`;
  return view.kind;
}

/** Which way the content travels. Stepping between two events moves along time:
 * a later event slides in from the right, an earlier one from the left. Any
 * other change is a kind swap, which fades on y instead. */
function slideDirection(prev: DockView | null, next: DockView): number {
  if (prev?.kind !== "event" || next.kind !== "event") return 0;
  return Math.sign(next.event.startMs - prev.event.startMs);
}

/** How the calendar seeds a new event: the day it's currently showing plus the
 * timed events on it, so the dock can land "create" on the next free slot. */
type CreateSeed = { dayStartMs: number; events: CalendarEvent[] };

/** A request to scroll the calendar to an item and pulse it. `startMs` locates
 * the day/time to scroll to (omitted for an item with no time — it only pulses
 * if already on screen); `flashId` is the item's reveal key (an event `_id` or
 * `googleEventId`). */
export type RevealInput = { startMs?: number; flashId: string };

interface DockContextValue {
  view: DockView | null;
  viewId: string | null;
  /** -1, 0 or 1 — passed to the content variants as `custom`. */
  direction: number;
  open: (view: DockView) => void;
  close: () => void;
  /** The calendar registers the day it's focused on (and that day's events) so
   * the dock's Create button can seed a new event there. Pass `null` to clear. */
  registerCreateSeed: (seed: CreateSeed | null) => void;
  /** Open a create view on the registered day's next free 30-min slot, falling
   * back to the next slot from now when the calendar hasn't registered one. */
  openCreate: () => void;
  /** The calendar registers how to scroll-and-pulse an item; pass `null` to
   * clear. Others (notification feed, assistant proposals) call `reveal`. */
  registerReveal: (fn: ((input: RevealInput) => void) | null) => void;
  /** Scroll the calendar to an item and pulse it. A no-op until the calendar
   * has mounted and registered a handler. */
  reveal: (input: RevealInput) => void;
}

const DockContext = createContext<DockContextValue | null>(null);

function WorkspaceCommandBindings({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useCommand("settings.open", () => {
    void navigate({ to: "/settings" });
  });
  return children;
}

export function DockProvider({ children }: { children: ReactNode }) {
  const { snapshot } = useQaliSettings();
  const primaryTimeZone = snapshot.settings.calendar.primaryTimeZone;
  const clock = useMemo(
    () => createZonedCalendarClock(primaryTimeZone),
    [primaryTimeZone],
  );
  // View and direction move together so the exiting and entering content always
  // agree on which way they are travelling.
  const [state, setState] = useState<{ view: DockView | null; direction: number }>({
    view: null,
    direction: 0,
  });

  const open = useCallback((next: DockView) => {
    setState((prev) => ({ view: next, direction: slideDirection(prev.view, next) }));
  }, []);

  const close = useCallback(() => setState({ view: null, direction: 0 }), []);

  // A ref, not state: the calendar re-registers on every scroll settle, and the
  // Create button only reads it on click — no render needs to track it.
  const createSeedRef = useRef<CreateSeed | null>(null);
  const registerCreateSeed = useCallback((seed: CreateSeed | null) => {
    createSeedRef.current = seed;
  }, []);

  const openCreate = useCallback(() => {
    const seed = createSeedRef.current;
    const nowMs = Date.now();
    // Calendar paging carries a browser Date only as a civil-date container.
    // Reconstruct that date and every candidate instant in the primary clock.
    const seedDate = seed ? new Date(seed.dayStartMs) : undefined;
    const civilDate = seedDate
      ? parseCivilDate(
          `${seedDate.getFullYear()}-${String(seedDate.getMonth() + 1).padStart(2, "0")}-${String(seedDate.getDate()).padStart(2, "0")}`,
        )
      : clock.today(nowMs);
    const nowWall = clock.instantToWallTime(nowMs);
    let minute = DEFAULT_EVENT_START_MINUTES;
    if (nowWall.date === civilDate) {
      minute = Math.max(
        minute,
        Math.ceil(nowWall.minute / (SNAP_MS / 60_000)) * (SNAP_MS / 60_000),
      );
    }
    let range: { startMs: number; endMs: number } | undefined;
    for (; minute < 24 * 60; minute += SNAP_MS / 60_000) {
      const resolved = clock.wallTimeToInstant(civilDate, minute, "reject");
      // A fresh default never silently chooses an overlap: use only an exact
      // candidate here. The form exposes an explicit earlier/later choice if a
      // user requests an ambiguous wall time.
      if (resolved.kind !== "exact") continue;
      const candidate = {
        startMs: resolved.instantMs,
        endMs: resolved.instantMs + DEFAULT_EVENT_DURATION_MS,
      };
      if (
        !(seed?.events ?? []).some(
          (event) =>
            !event.allDay &&
            event.startMs < candidate.endMs &&
            event.endMs > candidate.startMs,
        )
      ) {
        range = candidate;
        break;
      }
    }
    const fallback = clock.wallTimeToInstant(civilDate, DEFAULT_EVENT_START_MINUTES, "compatible");
    if (!range && fallback.kind !== "rejected") {
      range = {
        startMs: fallback.instantMs,
        endMs: fallback.instantMs + DEFAULT_EVENT_DURATION_MS,
      };
    }
    if (!range) return;
    open({ kind: "create", ...range });
  }, [clock, open]);

  // A ref, like the create seed: the calendar registers on mount and callers
  // only read it when they fire, so no render needs to track it.
  const revealRef = useRef<((input: RevealInput) => void) | null>(null);
  const registerReveal = useCallback(
    (fn: ((input: RevealInput) => void) | null) => {
      revealRef.current = fn;
    },
    [],
  );
  const reveal = useCallback((input: RevealInput) => {
    revealRef.current?.(input);
  }, []);

  const value = useMemo<DockContextValue>(
    () => ({
      view: state.view,
      viewId: state.view ? dockViewId(state.view) : null,
      direction: state.direction,
      open,
      close,
      registerCreateSeed,
      openCreate,
      registerReveal,
      reveal,
    }),
    [state, open, close, registerCreateSeed, openCreate, registerReveal, reveal],
  );

  return (
    <DockContext value={value}>
      <CommandProvider>
        <WorkspaceCommandBindings>{children}</WorkspaceCommandBindings>
      </CommandProvider>
    </DockContext>
  );
}

export function useDock(): DockContextValue {
  const ctx = useContext(DockContext);
  if (!ctx) throw new Error("useDock must be used within a DockProvider");
  return ctx;
}
