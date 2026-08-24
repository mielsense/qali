import type { AssistantProviderStatus } from "@qali/desktop-contracts";

import { CodexBoundaryError } from "./auth";

export const MAX_CODEX_FRAME_BYTES = 64 * 1024;

export type CodexLifecycleType = "thread.started" | "turn.started" | "turn.completed" | "turn.failed" | "error";
export type CodexEvent =
  | Readonly<{ kind: "lifecycle"; type: CodexLifecycleType }>
  | Readonly<{ kind: "assistant-message"; text: string }>
  | Readonly<{ kind: "reasoning"; text: string }>;

export type CodexLoginEvent =
  | Readonly<{ kind: "progress"; stage: "preparing" | "requesting-code" | "instructions" | "credentials-stored" }>
  | Readonly<{ kind: "challenge-url"; url: string }>
  | Readonly<{ kind: "challenge-code"; code: string }>
  | Readonly<{
      kind: "status";
      status: Exclude<AssistantProviderStatus, { kind: "offline" }>;
    }>;

export type CodexLoginEventEnvelope = Readonly<{
  attemptId: string;
  event: CodexLoginEvent;
}>;

export type CodexLoginEventChannel = Readonly<{ kind: "qali-codex-login-events" }>;
type LoginEventSubscriber = (envelope: CodexLoginEventEnvelope) => void | Promise<void>;
type LoginEventChannelState = {
  subscriber?: LoginEventSubscriber;
  closeListeners: Set<() => void>;
};
const LOGIN_EVENT_CHANNELS = new WeakMap<object, LoginEventChannelState>();

export function createCodexLoginEventChannel(): CodexLoginEventChannel {
  const channel = Object.freeze({ kind: "qali-codex-login-events" as const });
  LOGIN_EVENT_CHANNELS.set(channel, { closeListeners: new Set() });
  return channel;
}

function resolveLoginEventChannel(channel: CodexLoginEventChannel): LoginEventChannelState {
  const state = typeof channel === "object" && channel !== null
    ? LOGIN_EVENT_CHANNELS.get(channel)
    : undefined;
  if (!state) {
    throw new CodexBoundaryError("CODEX_LOGIN_EVENT_SINK_CLOSED", "Application-owned login event sink is required");
  }
  return state;
}

export function subscribeCodexLoginEvents(
  channel: CodexLoginEventChannel,
  subscriber: LoginEventSubscriber,
): () => void {
  const state = resolveLoginEventChannel(channel);
  if (state.subscriber) {
    throw new CodexBoundaryError("CODEX_LOGIN_EVENT_SINK_CLOSED", "Login event sink already has a subscriber");
  }
  state.subscriber = subscriber;
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    if (state.subscriber === subscriber) state.subscriber = undefined;
    for (const listener of [...state.closeListeners]) listener();
  };
}

export function hasCodexLoginEventSubscriber(channel: CodexLoginEventChannel): boolean {
  return Boolean(resolveLoginEventChannel(channel).subscriber);
}

export async function publishCodexLoginEvent(
  channel: CodexLoginEventChannel,
  envelope: CodexLoginEventEnvelope,
): Promise<void> {
  const subscriber = resolveLoginEventChannel(channel).subscriber;
  if (!subscriber) {
    throw new CodexBoundaryError("CODEX_LOGIN_EVENT_SINK_CLOSED", "Login event subscriber is unavailable");
  }
  await subscriber(envelope);
}

export function observeCodexLoginEventUnsubscribe(
  channel: CodexLoginEventChannel,
  listener: () => void,
): () => void {
  const state = resolveLoginEventChannel(channel);
  state.closeListeners.add(listener);
  return () => state.closeListeners.delete(listener);
}

export function parseCodexLoginLine(line: string): CodexLoginEvent {
  if (Buffer.byteLength(line, "utf8") > MAX_CODEX_FRAME_BYTES) {
    throw new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_OVERFLOW", "Codex login emitted an oversized line");
  }
  const value = line.trim();
  if (
    value === "Preparing device code login" ||
    /^Welcome to Codex \[v\d+(?:\.\d+){1,2}\]$/.test(value) ||
    value === "OpenAI's command-line coding agent"
  ) {
    return { kind: "progress", stage: "preparing" };
  }
  if (value === "Requesting a one-time code...") return { kind: "progress", stage: "requesting-code" };
  if (
    value === "Follow these steps to sign in with ChatGPT using device code authorization:" ||
    value === "1. Open this link in your browser and sign in" ||
    value === "1. Open this link in your browser and sign in to your account" ||
    value === "2. Enter this one-time code after you are signed in (expires in 15 minutes)" ||
    value === "(expires in 15 minutes)" ||
    value.startsWith("Continue only if you started this login in Codex.")
  ) return { kind: "progress", stage: "instructions" };
  if (/^Successfully logged in\.?$/.test(value)) return { kind: "progress", stage: "credentials-stored" };
  if (value.length <= 2_048 && /^https:\/\/auth\.openai\.com\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(value)) {
    return { kind: "challenge-url", url: value };
  }
  if (/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,3}$/.test(value)) {
    return { kind: "challenge-code", code: value };
  }
  const labelledCode = /^2\. Enter this one-time code ([A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,3})$/.exec(value);
  if (labelledCode) return { kind: "challenge-code", code: labelledCode[1]! };
  throw new CodexBoundaryError("CODEX_LOGIN_PROTOCOL_INVALID", "Codex login emitted an unknown line");
}

const LIFECYCLE_EVENTS = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "error"]);
const TOOL_ITEM_TYPES = new Set([
  "command_execution", "file_change", "mcp_tool_call", "web_search", "image_generation",
  "browser", "computer_use", "collaboration", "delegation", "apply_patch", "tool_call",
]);

export function parseCodexJsonLine(line: string): CodexEvent {
  if (Buffer.byteLength(line, "utf8") > MAX_CODEX_FRAME_BYTES) {
    throw new CodexBoundaryError("CODEX_PROTOCOL_OVERFLOW", "Codex emitted an oversized event");
  }
  let value: unknown;
  try { value = JSON.parse(line); } catch {
    throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex emitted malformed JSONL");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex emitted an invalid event envelope");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") {
    throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex event has no type");
  }
  if (LIFECYCLE_EVENTS.has(record.type)) return { kind: "lifecycle", type: record.type as CodexLifecycleType };
  if (!["item.started", "item.updated", "item.completed"].includes(record.type)) {
    throw new CodexBoundaryError("CODEX_UNKNOWN_EVENT", "Codex emitted an unknown event");
  }
  if (!record.item || typeof record.item !== "object" || Array.isArray(record.item)) {
    throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex emitted an invalid item");
  }
  const item = record.item as Record<string, unknown>;
  if (typeof item.type !== "string") throw new CodexBoundaryError("CODEX_PROTOCOL_INVALID", "Codex item has no type");
  if (TOOL_ITEM_TYPES.has(item.type) || /(?:tool|command|file|browser|computer|exec|patch|image|web|mcp)/i.test(item.type)) {
    throw new CodexBoundaryError("CODEX_TOOL_ATTEMPT", "Codex attempted an executable capability");
  }
  if (record.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string" && Buffer.byteLength(item.text, "utf8") <= MAX_CODEX_FRAME_BYTES) {
    return { kind: "assistant-message", text: item.text };
  }
  if (record.type === "item.completed" && item.type === "reasoning" && typeof item.text === "string" && Buffer.byteLength(item.text, "utf8") <= MAX_CODEX_FRAME_BYTES) {
    return { kind: "reasoning", text: item.text };
  }
  throw new CodexBoundaryError("CODEX_UNKNOWN_EVENT", "Codex emitted an unknown item type");
}
