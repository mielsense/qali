import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";
import type { ReactNode } from "react";

export function AssistantShell({
  children,
  onClose,
  onNewChat,
  newChatDisabled,
}: {
  children: ReactNode;
  onClose: () => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
}) {
  return (
    <section
      role="region"
      aria-label="Calendar assistant"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background p-4"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-border/60 pb-2.5">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Assistant</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Asks before it changes anything
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="quiet"
            size="sm"
            onClick={onNewChat}
            disabled={newChatDisabled}
            className="rounded-lg px-2 text-xs text-muted-foreground"
          >
            <HugeiconsIcon
              icon={Add01Icon}
              strokeWidth={2}
              className="size-4"
              aria-hidden
            />
            New chat
          </Button>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            onClick={onClose}
            className="rounded-lg text-muted-foreground"
            aria-label="Close assistant"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              strokeWidth={2}
              className="size-4"
              aria-hidden
            />
          </Button>
        </div>
      </header>
      {children}
    </section>
  );
}
