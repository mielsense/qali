import { Dialog } from "@base-ui/react/dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@qali/ui/lib/utils";

export function MotionDialog({
  open,
  onOpenChange,
  children,
  className,
  label,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  return (
    <AnimatePresence initial={false}>
      {mounted ? (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
          <Dialog.Portal keepMounted>
            <Dialog.Backdrop
              render={
                <motion.div
                  initial={false}
                  animate={{ opacity: open ? 1 : 0 }}
                  transition={
                    reduceMotion ? { duration: 0 } : { duration: 0.16 }
                  }
                  className="fixed inset-0 z-[90] bg-black/45 backdrop-blur-[2px]"
                />
              }
            />
            <Dialog.Viewport className="fixed inset-0 z-[91] flex items-start justify-center overflow-y-auto overscroll-contain px-4 pt-[min(18vh,168px)]">
              <Dialog.Popup
                aria-label={label}
                render={
                  <motion.div
                    initial={false}
                    animate={
                      open
                        ? { opacity: 1, scale: 1, y: 0 }
                        : { opacity: 0, scale: 0.975, y: -8 }
                    }
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : {
                            duration: open ? 0.2 : 0.14,
                            ease: [0.16, 1, 0.3, 1],
                          }
                    }
                    onAnimationComplete={() => {
                      if (!open) setMounted(false);
                    }}
                    className={cn(
                      "qali-surface qali-surface--floating w-full max-w-[620px] overflow-hidden rounded-2xl outline-none",
                      className,
                    )}
                  />
                }
              >
                {children}
              </Dialog.Popup>
            </Dialog.Viewport>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </AnimatePresence>
  );
}
