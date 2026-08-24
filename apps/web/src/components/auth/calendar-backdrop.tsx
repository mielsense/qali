const HOUR_HEIGHT = 64;
const DAY_WIDTH = 200;

const PREVIEW_EVENTS = [
  { title: "Focus", time: "9:00–10:30", x: -2, y: 1, color: "--event-4" },
  { title: "Stand-up", time: "11:00–11:30", x: 2, y: 4, color: "--event-6" },
  { title: "Lunch", time: "12:30–1:30", x: -3, y: 7, color: "--event-5" },
] as const;

/** A quiet calendar preview used only by desktop authentication. */
export function CalendarBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px),linear-gradient(to right, color-mix(in oklab, var(--border) 55%, transparent) 0 1px, transparent 1px)",
          backgroundSize: `100% ${HOUR_HEIGHT}px, ${DAY_WIDTH}px 100%`,
          backgroundPosition: "0 0, 50vw 0",
          maskImage:
            "radial-gradient(100% 90% at 50% 48%, black 30%, transparent 90%)",
        }}
      />
      {PREVIEW_EVENTS.map((event) => (
        <div
          key={event.title}
          className="absolute hidden h-[56px] w-[184px] overflow-hidden rounded-xl border px-3 py-2 opacity-45 sm:block"
          style={{
            left: `calc(50vw + ${event.x * DAY_WIDTH + 8}px)`,
            top: event.y * HOUR_HEIGHT + 4,
            borderColor: `color-mix(in oklab, var(${event.color}) 65%, var(--border))`,
            backgroundColor: `color-mix(in oklab, var(${event.color}) 20%, var(--background))`,
          }}
        >
          <p className="text-xs font-medium">{event.title}</p>
          <p className="text-[10px] text-muted-foreground">{event.time}</p>
        </div>
      ))}
    </div>
  );
}
