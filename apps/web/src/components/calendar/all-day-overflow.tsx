import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@qali/ui/components/popover";
import { useDock } from "@/components/workspace/dock-context";
import { useEventColor } from "./colors";
import { ALLDAY_EVENT_HEIGHT, type AllDayEventLayout } from "./lib";
import { eventSurfacePresentation } from "./event-surface";

/** A compact, keyboard-accessible way to reach events below the all-day row. */
export function AllDayOverflow({
  events,
  visible,
}: {
  events: readonly AllDayEventLayout[];
  visible?: Pick<AllDayEventLayout, "event">;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const { open } = useDock();
  const colorFor = useEventColor();
  if (!events.length) return null;
  return (
    <Popover open={previewOpen} onOpenChange={setPreviewOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={180}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible"))
            setPreviewOpen(true);
        }}
        aria-label={`${events.length} more all-day ${events.length === 1 ? "event" : "events"}`}
        className="inline-flex h-5 min-w-6 items-center justify-center rounded-md border border-border bg-accent px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--qali-accent)]"
      >
        +{events.length}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        initialFocus={false}
        aria-label="More all-day events"
        className="w-72 p-2"
      >
        <div className="relative flex max-h-80 flex-col gap-1 overflow-y-auto overscroll-contain p-0.5">
          {[...events, ...(visible ? [visible] : [])].map(({ event }) => {
            const surface = eventSurfacePresentation({
              colorVar: colorFor(event),
              variant: "all-day",
            });
            return (
              <button
                key={event._id}
                type="button"
                title={`${event.summary || "(No title)"} · ${allDayPreviewDates(event.startMs, event.endMs)}`}
                onClick={() => {
                  setPreviewOpen(false);
                  open({ kind: "event", event });
                }}
                className="flex w-full shrink-0 items-center overflow-hidden border px-2.5 text-left text-xs font-medium transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                style={{
                  height: ALLDAY_EVENT_HEIGHT,
                  borderRadius: surface.radiusPx,
                  background: surface.backgroundColor,
                  borderColor: surface.borderColor,
                  boxShadow: surface.boxShadow,
                  color: surface.color,
                }}
              >
                <span className="truncate">
                  {event.summary || "(No title)"}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** All-day timestamps encode civil dates at UTC midnight, with an exclusive end. */
export function allDayPreviewDates(startMs: number, endMs: number): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const lastDay = Math.max(startMs, endMs - 86_400_000);
  return lastDay === startMs
    ? formatter.format(startMs)
    : `${formatter.format(startMs)} – ${formatter.format(lastDay)}`;
}
