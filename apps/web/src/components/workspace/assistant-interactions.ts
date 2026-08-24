const SCROLL_FOLLOW_THRESHOLD_PX = 48;

export function isNearScrollBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return scrollHeight - scrollTop - clientHeight <= SCROLL_FOLLOW_THRESHOLD_PX;
}

export function shouldSendAssistantMessage({
  key,
  shiftKey,
  isComposing,
}: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}

export function shouldOpenAssistantShortcut(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "defaultPrevented"
  >,
  options: { blocked: boolean; editableTarget: boolean },
): boolean {
  return (
    !event.defaultPrevented &&
    !options.blocked &&
    !options.editableTarget &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "j"
  );
}

export function isEditableAssistantShortcutTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

export function safeAssistantLink(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Renderer-facing failure copy is intentionally a bounded vocabulary. Native
 * frames and provider stderr must never become UI text. */
export type AssistantFailureKind =
  | "probing"
  | "authentication-required"
  | "needs-reprobe"
  | "incompatible"
  | "unavailable"
  | "probe-failed"
  | "timed-out"
  | "outcome-unknown";

export function assistantFailurePresentation(kind: AssistantFailureKind) {
  switch (kind) {
    case "probing": return { title: "Checking Codex", action: null };
    case "authentication-required": return { title: "Sign in to Codex", action: "sign-in" as const };
    case "needs-reprobe": return { title: "Codex changed", action: "check-again" as const };
    case "incompatible": return { title: "Unsupported Codex version", action: "choose-codex" as const };
    case "unavailable": return { title: "Assistant unavailable", action: "retry" as const };
    case "probe-failed": return { title: "Couldn’t verify Codex", action: "check-again" as const };
    case "timed-out": return { title: "The response timed out", action: "retry" as const };
    case "outcome-unknown": return { title: "The response outcome is unknown", action: null };
  }
}

function eventIdOf(input: unknown): string | null {
  if (input && typeof input === "object" && "eventId" in input) {
    const id = (input as { eventId?: unknown }).eventId;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** The start instant of a proposal's `time` argument, when it's a timed range.
 * All-day ranges (calendar dates) and absent times return undefined — the
 * reveal then flashes without a vertical scroll. */
function timedStartMs(input: unknown): number | undefined {
  if (!input || typeof input !== "object" || !("time" in input)) return undefined;
  const time = (input as { time?: unknown }).time;
  if (
    time &&
    typeof time === "object" &&
    (time as { kind?: unknown }).kind === "timed"
  ) {
    const startMs = (time as { startMs?: unknown }).startMs;
    return typeof startMs === "number" ? startMs : undefined;
  }
  return undefined;
}

/** Where the calendar should scroll and what it should pulse once an assistant
 * proposal is applied. Returns null when there is nothing to reveal (a deletion).
 * `input` is the stored tool-argument JSON.
 *
 * - create_event: no id yet, so flash by `operationId` — Google's client-chosen
 *   id, which is what the event syncs back in as (`googleEventId`).
 * - move_event / update_event: flash by `eventId` (the Convex `_id`); a change
 *   with no new time still pulses the card in place. */
export function revealTargetForAction(action: {
  tool: string;
  input: string;
  operationId?: string;
}): { startMs?: number; flashId: string } | null {
  let input: unknown;
  try {
    input = JSON.parse(action.input);
  } catch {
    return null;
  }
  const startMs = timedStartMs(input);
  const withStart = (flashId: string) =>
    startMs != null ? { flashId, startMs } : { flashId };

  switch (action.tool) {
    case "create_event":
      return action.operationId ? withStart(action.operationId) : null;
    case "move_event":
    case "update_event": {
      const eventId = eventIdOf(input);
      return eventId ? withStart(eventId) : null;
    }
    default:
      // delete_event: nothing to reach for.
      return null;
  }
}

export function acknowledgedAssistantUserMessageId<T extends string>(
  messages:
    | readonly {
        _id: T;
        role: string;
        blocks: readonly { type: string; text?: string }[];
      }[]
    | undefined,
  previousUserMessageId: T | null,
  pendingText: string,
): T | null {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages?.[index];
    if (message?.role !== "user") continue;
    const text = message.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return message._id !== previousUserMessageId && text === pendingText
      ? message._id
      : null;
  }
  return null;
}

/** A fresh chat deliberately ignores the prior latest thread until the accepted
 * send creates a different durable row. This prevents the old transcript from
 * flashing back into view during the subscription handoff. */
export function freshAssistantThreadId<T extends string>(input: {
  startFresh: boolean;
  currentThreadId: T | null;
  latestThreadId: T | null;
  acceptedPreviousThreadId: T | null | undefined;
}): T | null {
  if (input.currentThreadId || !input.latestThreadId) return null;
  if (!input.startFresh) return input.latestThreadId;
  if (input.acceptedPreviousThreadId === undefined) return null;
  return input.latestThreadId === input.acceptedPreviousThreadId
    ? null
    : input.latestThreadId;
}

/** Keep the Stop target stable across the gap between native acceptance and the
 * renderer subscription. A matching user row alone is not terminal evidence:
 * it merely proves the command reached Qali. */
export function assistantAttemptSettled<T extends string>(
  messages:
    | readonly {
        _id: T;
        role: string;
        status?: string;
        blocks: readonly { type: string; text?: string }[];
      }[]
    | undefined,
  previousUserMessageId: T | null,
  pendingText: string,
): boolean {
  const acknowledgedId = acknowledgedAssistantUserMessageId(
    messages,
    previousUserMessageId,
    pendingText,
  );
  if (!acknowledgedId) return false;
  const acknowledgedIndex = messages?.findIndex((message) => message._id === acknowledgedId) ?? -1;
  return (messages?.slice(acknowledgedIndex + 1) ?? []).some(
    (message) => message.role === "assistant" && message.status !== "streaming",
  );
}
