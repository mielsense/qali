import { cn } from "@qali/ui/lib/utils";

import type { TimeGridPlacement } from "./time-gutter";

interface GhostEventProps {
  startMs: number;
  endMs: number;
  placement: TimeGridPlacement;
  timeZone: string;
  pending: boolean;
  wallClock?: boolean;
}

export function GhostEvent({
  startMs,
  endMs,
  placement,
  timeZone,
  pending,
  wallClock = false,
}: GhostEventProps) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const rangeLabel = `${formatter.format(startMs)} – ${formatter.format(endMs)}`;
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-1 z-30 min-h-[14px] rounded-md border border-dashed border-primary/40 bg-primary/10 px-2 py-0.5",
        pending && "animate-pulse border-solid",
      )}
      data-wall-clock={wallClock || undefined}
      style={{
        top: `${placement.topPct}%`,
        height: `${placement.heightPct}%`,
      }}
    >
      <p className="truncate text-xs font-medium text-primary">
        {pending ? "New event" : rangeLabel}
      </p>
    </div>
  );
}
