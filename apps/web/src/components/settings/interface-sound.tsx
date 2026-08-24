import { playClickSound } from "@qali/ui/lib/sound";
import { type ReactNode, useEffect } from "react";

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[role='switch']",
].join(",");

type ClosestTarget = Readonly<{
  closest(selector: string): unknown;
}>;

type InteractiveTarget = ClosestTarget &
  Readonly<{
    matches(selector: string): boolean;
  }>;

export function shouldPlayInterfaceSound(target: unknown): boolean {
  if (
    !target ||
    typeof target !== "object" ||
    !("closest" in target) ||
    typeof (target as ClosestTarget).closest !== "function"
  ) {
    return false;
  }
  const interactive = (target as ClosestTarget).closest(
    INTERACTIVE_SELECTOR,
  ) as InteractiveTarget | null;
  if (!interactive || typeof interactive.matches !== "function") return false;
  if (
    interactive.matches(
      ":disabled,[aria-disabled='true'],[data-interface-sound='off']",
    )
  ) {
    return false;
  }
  return !interactive.closest("[data-interface-sound='off']");
}

/** One delegated click path keeps every semantic control consistent and avoids
 * the double sounds that accumulated when components played audio themselves. */
export function InterfaceSoundBoundary({ children }: { children: ReactNode }) {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (shouldPlayInterfaceSound(event.target)) playClickSound();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return children;
}
