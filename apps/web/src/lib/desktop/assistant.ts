import type {
  AssistantAttemptId,
  AssistantProviderStatus,
  AssistantLoginResult,
  AssistantOpenLoginRequest,
  AssistantSendResult,
  DesktopStatusEvent,
  QaliDesktopApi,
} from "@qali/desktop-contracts";
import {
  assistantAttemptIdSchema,
  assistantProviderStatusSchema,
  assistantLoginResultSchema,
  assistantOpenLoginRequestSchema,
  assistantSendRequestSchema,
  assistantSendResultSchema,
  chooseCodexInstallationResultSchema,
  desktopStatusEventSchema,
  type ChooseCodexInstallationResult,
} from "@qali/desktop-contracts/schemas";

type DesktopAssistantBridge = Pick<QaliDesktopApi, "assistant"> & {
  assistant: QaliDesktopApi["assistant"] & {
    chooseCodexInstallation?(): Promise<ChooseCodexInstallationResult>;
  };
};

export type DesktopAssistant = Readonly<{
  status(): Promise<AssistantProviderStatus>;
  login(): Promise<AssistantLoginResult>;
  openLoginUrl(request: AssistantOpenLoginRequest): Promise<void>;
  chooseCodexInstallation(): Promise<ChooseCodexInstallationResult>;
  send(text: string, timeZone: string): Promise<AssistantSendResult>;
  cancel(attemptId: AssistantAttemptId): Promise<void>;
}>;

function assertAssistantBridge(
  value: unknown,
): asserts value is DesktopAssistantBridge {
  if (value === null || typeof value !== "object") {
    throw new Error("Desktop preload bridge is malformed");
  }
  const assistant = (value as { assistant?: unknown }).assistant;
  if (assistant === null || typeof assistant !== "object") {
    throw new Error("Desktop preload bridge is malformed");
  }
  for (const method of [
    "status",
    "login",
    "openLoginUrl",
    "send",
    "cancel",
  ] as const) {
    if (typeof (assistant as Record<string, unknown>)[method] !== "function") {
      throw new Error("Desktop preload bridge is malformed");
    }
  }
}

export function createDesktopAssistant(
  bridge: DesktopAssistantBridge,
): DesktopAssistant {
  return Object.freeze({
    async status() {
      return assistantProviderStatusSchema.parse(
        await bridge.assistant.status(),
      );
    },
    async login() {
      return assistantLoginResultSchema.parse(await bridge.assistant.login());
    },
    async openLoginUrl(request) {
      await bridge.assistant.openLoginUrl(
        assistantOpenLoginRequestSchema.parse(request),
      );
    },
    async chooseCodexInstallation() {
      const choose = bridge.assistant.chooseCodexInstallation;
      if (typeof choose !== "function") {
        throw new Error("Desktop preload bridge is malformed");
      }
      return chooseCodexInstallationResultSchema.parse(await choose());
    },
    async send(text, timeZone) {
      const request = assistantSendRequestSchema.parse({
        text: text.trim(),
        timeZone,
      });
      return assistantSendResultSchema.parse(
        await bridge.assistant.send(request),
      );
    },
    async cancel(attemptId) {
      await bridge.assistant.cancel(assistantAttemptIdSchema.parse(attemptId));
    },
  });
}

export type DesktopAssistantChallenge = Readonly<{ url: string; code: string }>;
export type DesktopAssistantSessionSnapshot = Readonly<{
  attemptId: string | null;
  challenge: DesktopAssistantChallenge | null;
  progress: string | null;
  status: AssistantProviderStatus | null;
}>;

export type DesktopAssistantSession = Readonly<{
  cancel(): Promise<void>;
  dispose(): void;
  getSnapshot(): DesktopAssistantSessionSnapshot;
  login(): Promise<AssistantLoginResult>;
  openChallenge(): Promise<void>;
  refreshStatus(): Promise<AssistantProviderStatus>;
  subscribe(
    listener: (snapshot: DesktopAssistantSessionSnapshot) => void,
  ): () => void;
}>;

export function createDesktopAssistantSession(
  bridge: Pick<QaliDesktopApi, "assistant" | "events">,
): DesktopAssistantSession {
  assertAssistantBridge(bridge);
  const assistant = createDesktopAssistant(bridge);
  const listeners = new Set<
    (snapshot: DesktopAssistantSessionSnapshot) => void
  >();
  const pendingEvents = new Map<string, DesktopStatusEvent[]>();
  const cancelledAttempts = new Set<string>();
  let generation = 0;
  let disposed = false;
  let loginInFlight: Promise<AssistantLoginResult> | null = null;
  let snapshot: DesktopAssistantSessionSnapshot = Object.freeze({
    attemptId: null,
    challenge: null,
    progress: null,
    status: null,
  });
  const publish = (patch: Partial<DesktopAssistantSessionSnapshot>) => {
    if (disposed) return;
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of listeners) listener(snapshot);
  };
  const applyEvent = (value: unknown) => {
    const envelope = desktopStatusEventSchema.parse(value);
    if (envelope.type === "assistant-status") {
      if (loginInFlight || snapshot.attemptId) return;
      publish({ status: envelope.status });
      return;
    }
    if (envelope.type !== "assistant-login") return;
    if (snapshot.attemptId === null) {
      if (pendingEvents.size >= 8 && !pendingEvents.has(envelope.attemptId)) {
        pendingEvents.delete(pendingEvents.keys().next().value!);
      }
      const buffered = pendingEvents.get(envelope.attemptId) ?? [];
      if (buffered.length < 16) buffered.push(envelope);
      pendingEvents.set(envelope.attemptId, buffered);
      return;
    }
    if (envelope.attemptId !== snapshot.attemptId) return;
    if (envelope.event.kind === "challenge") {
      publish({
        challenge: { url: envelope.event.url, code: envelope.event.code },
      });
    } else if (envelope.event.kind === "progress") {
      publish({ progress: envelope.event.stage });
    } else {
      publish({
        status: envelope.event.status,
        attemptId: null,
        challenge: null,
        progress: null,
      });
    }
  };
  const unsubscribeBridge = bridge.events.subscribe(applyEvent);
  const cancelAttempt = async (attemptId: string) => {
    if (cancelledAttempts.has(attemptId)) return;
    if (cancelledAttempts.size >= 32) {
      cancelledAttempts.delete(cancelledAttempts.values().next().value!);
    }
    cancelledAttempts.add(attemptId);
    await assistant.cancel(attemptId);
  };
  const login = async (): Promise<AssistantLoginResult> => {
    if (disposed) throw new Error("Assistant login session is disposed");
    if (snapshot.attemptId) {
      return { kind: "started", attemptId: snapshot.attemptId };
    }
    if (loginInFlight) return loginInFlight;

    const ownGeneration = ++generation;
    pendingEvents.clear();
    publish({ attemptId: null, challenge: null, progress: "preparing" });
    const pendingLogin = (async () => {
      const result = await assistant.login();
      if (disposed || ownGeneration !== generation) {
        pendingEvents.clear();
        if (result.kind === "started") {
          await cancelAttempt(result.attemptId).catch(() => {});
        }
        return result;
      }
      if (result.kind === "rejected") {
        publish({
          attemptId: null,
          challenge: null,
          progress: null,
          status: result.status,
        });
        return result;
      }
      publish({ attemptId: result.attemptId });
      const pending = pendingEvents.get(result.attemptId) ?? [];
      pendingEvents.clear();
      for (const event of pending) applyEvent(event);
      return result;
    })();
    loginInFlight = pendingLogin;
    try {
      return await pendingLogin;
    } finally {
      if (loginInFlight === pendingLogin) loginInFlight = null;
    }
  };
  return Object.freeze({
    async refreshStatus() {
      let status = await assistant.status();
      publish({ status });
      // The native host deliberately makes its first observation non-blocking:
      // `probing` starts the compatibility probe in the background. One
      // immediate follow-up joins that same in-flight probe and yields the
      // authoritative ready/remediation state instead of leaving the renderer
      // parked on "Checking Codex" forever.
      if (status.kind === "probing") {
        status = await assistant.status();
        publish({ status });
      }
      return status;
    },
    login,
    async cancel() {
      const attemptId = snapshot.attemptId;
      ++generation;
      pendingEvents.clear();
      publish({ attemptId: null, challenge: null, progress: null });
      if (attemptId) await cancelAttempt(attemptId);
    },
    async openChallenge() {
      const attemptId = snapshot.attemptId;
      const challenge = snapshot.challenge;
      if (!attemptId || !challenge) {
        throw new Error("Assistant login challenge is unavailable");
      }
      await assistant.openLoginUrl({ attemptId, ...challenge });
      if (
        snapshot.attemptId === attemptId &&
        snapshot.challenge?.url === challenge.url &&
        snapshot.challenge.code === challenge.code
      ) {
        publish({ challenge: null });
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) throw new Error("Assistant login session is disposed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      const activeAttemptId = snapshot.attemptId;
      disposed = true;
      ++generation;
      pendingEvents.clear();
      snapshot = Object.freeze({
        attemptId: null,
        challenge: null,
        progress: null,
        status: snapshot.status,
      });
      listeners.clear();
      unsubscribeBridge();
      if (activeAttemptId) void cancelAttempt(activeAttemptId).catch(() => {});
    },
  });
}

export function desktopAssistantFor(
  windowValue: { qali?: unknown } | undefined = typeof window === "undefined"
    ? undefined
    : window,
): DesktopAssistant | null {
  if (
    windowValue === undefined ||
    !Object.prototype.hasOwnProperty.call(windowValue, "qali")
  ) {
    return null;
  }
  assertAssistantBridge(windowValue.qali);
  return createDesktopAssistant(windowValue.qali);
}

export function desktopAssistantSessionFor(
  windowValue: { qali?: unknown } | undefined = typeof window === "undefined"
    ? undefined
    : window,
): DesktopAssistantSession | null {
  if (
    windowValue === undefined ||
    !Object.prototype.hasOwnProperty.call(windowValue, "qali")
  ) {
    return null;
  }
  assertAssistantBridge(windowValue.qali);
  const events = (windowValue.qali as { events?: unknown }).events;
  if (
    events === null ||
    typeof events !== "object" ||
    typeof (events as { subscribe?: unknown }).subscribe !== "function"
  ) {
    throw new Error("Desktop preload bridge is malformed");
  }
  return createDesktopAssistantSession(
    windowValue.qali as unknown as Pick<QaliDesktopApi, "assistant" | "events">,
  );
}

export function assistantCopy(status: AssistantProviderStatus): string | null {
  switch (status.kind) {
    case "ready":
      return null;
    case "ready-degraded":
      return "Codex is available with limited capabilities.";
    case "probing":
      return "Checking the Codex installation…";
    case "authentication-required":
      return "Sign in to Codex to use the assistant.";
    case "needs-reprobe":
      return "The Codex installation changed and must be checked again.";
    case "incompatible":
      return "The installed Codex CLI is incompatible or unverified.";
    case "probe-failed":
      return "The Codex installation could not be verified.";
    case "unavailable":
      return "The assistant is unavailable in this build.";
    case "offline":
      return "The assistant is unavailable.";
  }
}

export function assistantInstallationCopy(
  result: ChooseCodexInstallationResult,
): string | null {
  switch (result.kind) {
    case "selected":
      return assistantCopy(result.status);
    case "cancelled":
      return null;
    case "missing":
      return "The selected Codex executable was not found.";
    case "incompatible":
      return (
        assistantCopy(result.status) ??
        "The selected Codex executable is incompatible."
      );
  }
}

export function assistantSendError(result: AssistantSendResult): string | null {
  if (result.kind === "accepted") return null;
  if (result.message) return result.message;
  switch (result.reason) {
    case "authentication-required":
      return "Sign in to Codex before sending.";
    case "busy":
      return "Another assistant request is already running.";
    case "probing":
      return "The Codex installation is still being checked.";
    case "entitlement-required":
      return "This Codex account does not have the required entitlement.";
    case "incompatible":
      return "The installed Codex CLI is incompatible or unverified.";
    case "model-unavailable":
      return "The selected Codex model is unavailable.";
    case "needs-reprobe":
      return "The Codex installation changed and must be checked again.";
    case "probe-failed":
      return "The Codex installation could not be verified.";
    case "quota-exceeded":
      return "The Codex quota is exhausted. Try again later.";
    case "schema-failure":
      return "The assistant returned an invalid response.";
    case "cancelled":
      return "The assistant request was cancelled.";
    case "unavailable":
      return "The assistant is unavailable in this build.";
  }
}
