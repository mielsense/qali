import { cn } from "@qali/ui/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

import { EventCreate } from "@/components/calendar/event-create";
import { EventDetail } from "@/components/calendar/event-detail";
import { EventEdit } from "@/components/calendar/event-edit";
import {
  dockVariants,
  dockVariantsReduced,
  SPRING_DOCK,
} from "@/components/calendar/motion";

import { AccountPanel } from "./account-panel";
import { useDock, type DockView } from "./dock-context";

function widthClass(view: DockView): string {
  return view.kind === "account"
    ? "w-[min(19rem,calc(100vw-2rem))]"
    : "w-[min(27rem,calc(100vw-2rem))]";
}

/**
 * Contextual event surface. Global actions live in AppRail; this panel exists
 * only while the user is creating, reading, or editing an event.
 */
export function BottomIsland() {
  const { view, viewId, direction, open, close } = useDock();
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!view) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (view.kind === "create" || view.kind === "edit") return;
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || ref.current?.contains(target)) return;
      if (target.closest("[data-event],[data-dock-keep-open]")) return;
      if (
        target.closest(
          "[data-slot='popover-content'],[data-slot='dropdown-menu-content'],[data-slot='goo-dropdown-content']",
        )
      ) {
        return;
      }
      if (view.kind !== "create" && view.kind !== "edit") close();
    };
    window.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => {
      window.addEventListener("pointerdown", onPointerDown);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close, view]);

  if (!view) return null;
  const variants = reducedMotion ? dockVariantsReduced : dockVariants;

  return (
    <motion.nav
      ref={ref}
      data-floating-action-dock
      layout
      transition={SPRING_DOCK}
      style={{ borderRadius: 20, willChange: "transform" }}
      className={cn(
        "qali-goo-surface pointer-events-auto overflow-hidden p-4",
        widthClass(view),
      )}
    >
      <AnimatePresence mode="popLayout" initial={false} custom={direction}>
        <motion.div
          key={viewId ?? "event-panel"}
          custom={direction}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          style={{ willChange: "transform, filter" }}
        >
          {view.kind === "event" ? (
            <EventDetail
              event={view.event}
              onClose={close}
              onEdit={() => open({ kind: "edit", event: view.event })}
              onDuplicate={(prefill, startMs, endMs) =>
                open({ kind: "create", startMs, endMs, prefill })
              }
            />
          ) : view.kind === "edit" ? (
            <EventEdit
              event={view.event}
              onCancel={() => open({ kind: "event", event: view.event })}
              onSaved={() => open({ kind: "event", event: view.event })}
            />
          ) : view.kind === "create" ? (
            <EventCreate
              startMs={view.startMs}
              endMs={view.endMs}
              prefill={view.prefill}
              onChangeRange={(startMs, endMs) =>
                open({ ...view, startMs, endMs })
              }
              onCancel={close}
              onCreated={close}
            />
          ) : (
            <AccountPanel onClose={close} />
          )}
        </motion.div>
      </AnimatePresence>
    </motion.nav>
  );
}
