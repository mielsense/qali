import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@qali/ui/lib/utils";

function Kbd({ className, ...props }: ComponentPropsWithoutRef<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "qali-control--raised inline-flex h-5 min-w-5 items-center justify-center rounded-md border px-1 font-sans text-[10px] font-medium leading-none text-foreground/80 tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
