import { CheckmarkCircle02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Doc, Id } from "@qali/backend/convex/_generated/dataModel";
import { useEffect, useMemo, useRef } from "react";

import { AssistantMarkdown } from "./assistant-markdown";
import { AssistantProposalCard, type AssistantAction } from "./assistant-proposal-card";
import { deriveAssistantTimelineRows } from "./assistant-timeline.logic";

type AssistantMessage = Doc<"assistantMessages">;

export function AssistantTimeline({
  messages,
  actionsById,
  onSend,
  busy,
}: {
  messages: readonly AssistantMessage[] | undefined;
  actionsById: ReadonlyMap<Id<"assistantActions">, AssistantAction>;
  onSend: (text: string) => void;
  busy: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const atEndRef = useRef(true);
  const rows = useMemo(
    () => deriveAssistantTimelineRows((messages ?? []) as unknown as Parameters<typeof deriveAssistantTimelineRows>[0]),
    [messages],
  );
  const latestSuggestions = messages?.at(-1)?.status === "complete"
    ? messages.at(-1)?.suggestions ?? []
    : [];

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && atEndRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [rows, busy]);

  return (
    <div
      ref={viewportRef}
      role="log"
      aria-label="Assistant conversation"
      aria-live="polite"
      aria-relevant="additions text"
      aria-busy={busy || undefined}
      onScroll={(event) => {
        const target = event.currentTarget;
        atEndRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 40;
      }}
      className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-1 py-1 [scrollbar-width:thin]"
    >
      {rows.map((row) => {
        if (row.kind === "user") {
          return <p key={row.id} className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-muted px-3 py-2 text-sm leading-5 whitespace-pre-wrap">{row.text}</p>;
        }
        if (row.kind === "assistant") {
          return <AssistantMarkdown key={row.id} text={row.text} />;
        }
        return (
          <WorkingSteps key={row.id} activeLabel={row.activeLabel} steps={row.steps} />
        );
      })}
      {(messages ?? []).map((message) => message.role === "assistant" ? message.blocks.map((block, index) => {
        if (block.type !== "proposal") return null;
        const action = actionsById.get(block.actionId);
        return action ? <AssistantProposalCard key={`${message._id}:${index}`} action={action} /> : null;
      }) : null)}
      {latestSuggestions.length ? (
        <div className="flex flex-wrap gap-1.5">
          {latestSuggestions.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => onSend(suggestion)} className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkingSteps({
  activeLabel,
  steps,
}: {
  activeLabel: string;
  steps: readonly { id: string; label: string; state: "complete" | "active" | "failed" }[];
}) {
  const active = steps.some((step) => step.state === "active");
  return (
    <details open={active} className="group rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <HugeiconsIcon icon={active ? Loading03Icon : CheckmarkCircle02Icon} strokeWidth={2} className={active ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"} aria-hidden />
        <span>{active ? activeLabel : "Worked"}</span>
      </summary>
      <ol className="mt-2 space-y-1 border-l border-border pl-3">
        {steps.map((step) => <li key={step.id} className="flex items-center gap-1.5"><span aria-hidden className={step.state === "complete" ? "size-1.5 rounded-full bg-muted-foreground" : step.state === "failed" ? "size-1.5 rounded-full bg-destructive" : "size-1.5 rounded-full bg-primary"} />{step.label}</li>)}
      </ol>
    </details>
  );
}
