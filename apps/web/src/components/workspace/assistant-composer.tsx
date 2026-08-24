import { ArrowUp02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@qali/ui/components/button";
import { GlassSurface } from "@qali/ui/components/glass-surface";
import { useLayoutEffect, useRef } from "react";

import {
  composerAction,
  resolveComposerHeight,
} from "./assistant-composer.logic";

export function AssistantComposer({
  draft,
  disabled,
  busy,
  onDraftChange,
  onSend,
  onStop,
  inputRef,
}: {
  draft: string;
  disabled: boolean;
  busy: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (node: HTMLTextAreaElement | null) => {
    localRef.current = node;
    inputRef.current = node;
  };

  useLayoutEffect(() => {
    const input = localRef.current;
    if (!input) return;
    input.style.height = "auto";
    const next = resolveComposerHeight(input.scrollHeight);
    input.style.height = `${next.height}px`;
    input.style.overflowY = next.scrollable ? "auto" : "hidden";
  }, [draft]);

  return (
    <GlassSurface variant="composer" className="p-1">
      <div className="flex items-end gap-1.5 rounded-[16px] bg-[var(--qali-glass-control-surface)] px-3 py-2">
        <textarea
          ref={setRef}
          value={draft}
          rows={1}
          aria-label="Message the assistant"
          placeholder="Ask about your calendar…"
          disabled={disabled && !busy}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            const action = composerAction({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
            });
            if (action === "send") {
              event.preventDefault();
              onSend();
            }
          }}
          className="min-h-10 flex-1 resize-none bg-transparent py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="button"
          variant="accent"
          size="icon-xs"
          aria-label={busy ? "Stop assistant" : "Send message"}
          onClick={busy ? onStop : onSend}
          disabled={busy ? false : disabled || draft.trim().length === 0}
          className="shrink-0 rounded-full"
        >
          <HugeiconsIcon
            icon={busy ? Cancel01Icon : ArrowUp02Icon}
            strokeWidth={2}
            className="size-3.5"
          />
        </Button>
      </div>
    </GlassSurface>
  );
}
