import {
  assistantCoordinatorAttemptIdSchema,
  assistantLoginAttemptIdSchema,
  parseIpcRequest,
  parseIpcResult,
  type AssistantOpenLoginRequest,
  type AssistantProviderStatus,
  type DesktopStatusEvent,
  type GoogleAccountsSnapshot,
  type IpcChannel,
  type LegacySettingsImportRequest,
  type SettingsPatchRequest,
  type SettingsResetRequest,
  type SettingsSnapshot,
  type SettingsWriteResult,
} from "@qali/desktop-contracts";
import {
  desktopStatusEventSchema,
  type ChooseCodexInstallationResult,
} from "@qali/desktop-contracts/schemas";
import type { IpcMain, IpcMainInvokeEvent, WebFrameMain } from "electron";

import { EXTERNAL_PRODUCT_LINK_CHANNEL } from "../external-links";
import { RENDERER_SCHEME } from "../protocol";
import type { CodexInstallationSelection } from "../codex/app-server-provider";
import type { CodexLoginEventEnvelope } from "../codex/events";

type SenderFrame = Pick<WebFrameMain, "frameToken" | "parent" | "url">;
export type RegisteredRendererWebContents = Pick<
  IpcMainInvokeEvent["sender"],
  "id" | "mainFrame"
>;
type RendererEvent = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;
type DesktopIpcHandler = (
  request: unknown,
  event: IpcMainInvokeEvent,
) => unknown | Promise<unknown>;

export type DesktopIpcHandlers = Record<IpcChannel, DesktopIpcHandler>;
export type GoogleOAuthIpcBroker = Readonly<{
  add(): Promise<Readonly<{ accountId: string }>>;
  clearLegacyCredentials(): Promise<void>;
  reconnect(accountId: string): Promise<Readonly<{ accountId: string }>>;
  disconnect(accountId: string): Promise<void>;
}>;
export type GoogleSyncIpcHandlers = Pick<
  DesktopIpcHandlers,
  | "google:status"
  | "google:add-account"
  | "google:clear-legacy-credentials"
  | "google:reconnect-account"
  | "google:disconnect-account"
  | "google:sync-account"
  | "google:sync-all"
>;
export type GoogleSyncIpcHandlerSet = GoogleSyncIpcHandlers &
  Readonly<{ dispose(): Promise<void>; revoke(): void }>;

export type AssistantIpcHandlers = Pick<
  DesktopIpcHandlers,
  | "assistant:status"
  | "assistant:login"
  | "assistant:open-login-url"
  | "assistant:choose-codex-installation"
  | "assistant:send"
  | "assistant:cancel"
>;
export type AssistantIpcHandlerSet = AssistantIpcHandlers &
  Readonly<{
    dispose(): Promise<void>;
    revoke(): void;
  }>;
export type RecoveryIpcHandlers = Pick<
  DesktopIpcHandlers,
  | "recovery:export"
  | "recovery:list-backups"
  | "recovery:restore"
  | "recovery:reset"
>;
export type SettingsIpcHandlers = Pick<
  DesktopIpcHandlers,
  | "settings:get"
  | "settings:patch"
  | "settings:reset"
  | "settings:import-legacy"
>;
export type UpdateIpcHandlers = Pick<
  DesktopIpcHandlers,
  "updates:status" | "updates:check" | "updates:install"
>;
export type RendererCapability =
  IpcChannel | typeof EXTERNAL_PRODUCT_LINK_CHANNEL;

export type AssistantLoginChallengeRegistry = Readonly<{
  activeAttemptId(): string | null;
  begin(attemptId: string): void;
  consume(request: AssistantOpenLoginRequest): string;
  invalidate(attemptId: string): boolean;
  isActive(attemptId: string): boolean;
  record(
    attemptId: string,
    event:
      | Readonly<{ kind: "challenge-url"; url: string }>
      | Readonly<{ kind: "challenge-code"; code: string }>,
  ): AssistantOpenLoginRequest | null;
}>;

const ASSISTANT_LOGIN_CHALLENGE_TTL_MS = 15 * 60 * 1_000;

/** The renderer requests an intention; only main ever receives the path. */
export function createCodexInstallationChooser(
  dependencies: Readonly<{
    showOpenDialog(
      options: Readonly<{
        properties: readonly ["openFile"];
        title: string;
      }>,
    ): Promise<Readonly<{ canceled: boolean; filePaths: readonly string[] }>>;
    selection: Pick<CodexInstallationSelection, "validate">;
  }>,
): () => Promise<ChooseCodexInstallationResult> {
  return async () => {
    const selection = await dependencies.showOpenDialog({
      properties: ["openFile"],
      title: "Choose Codex CLI",
    });
    if (selection.canceled) return { kind: "cancelled" };
    const path =
      selection.filePaths.length === 1 ? selection.filePaths[0] : undefined;
    if (!path) return { kind: "missing" };
    const result = await dependencies.selection.validate(path);
    if (result.kind === "supported") {
      return { kind: "selected", status: result.status };
    }
    return result;
  };
}

export function createAssistantLoginChallengeRegistry(
  options: Readonly<{ now?: () => number; ttlMs?: number }> = {},
): AssistantLoginChallengeRegistry {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ASSISTANT_LOGIN_CHALLENGE_TTL_MS;
  if (
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > ASSISTANT_LOGIN_CHALLENGE_TTL_MS
  ) {
    throw new Error("Assistant login challenge lifetime is invalid");
  }
  let active: {
    attemptId: string;
    code?: string;
    expiresAt?: number;
    issued: boolean;
    opened: boolean;
    url?: string;
  } | null = null;
  const unavailable = () => {
    throw new Error("Assistant login challenge is not active");
  };
  return Object.freeze({
    activeAttemptId: () => active?.attemptId ?? null,
    begin(attemptId) {
      active = { attemptId, issued: false, opened: false };
    },
    consume(request) {
      if (
        !active ||
        active.attemptId !== request.attemptId ||
        active.opened ||
        !active.issued ||
        !active.url ||
        !active.code ||
        active.expiresAt === undefined ||
        active.expiresAt <= now() ||
        active.url !== request.url ||
        active.code !== request.code
      ) {
        return unavailable();
      }
      const url = active.url;
      active = {
        attemptId: active.attemptId,
        issued: true,
        opened: true,
      };
      return url;
    },
    invalidate(attemptId) {
      if (active?.attemptId !== attemptId) return false;
      active = null;
      return true;
    },
    isActive: (attemptId) => active?.attemptId === attemptId,
    record(attemptId, event) {
      if (!active || active.attemptId !== attemptId || active.opened)
        return null;
      if (event.kind === "challenge-url") {
        if (active.url !== undefined && active.url !== event.url) {
          active = null;
          return null;
        }
        active.url = event.url;
      } else {
        if (active.code !== undefined && active.code !== event.code) {
          active = null;
          return null;
        }
        active.code = event.code;
      }
      if (!active.url || !active.code || active.issued) return null;
      active.issued = true;
      active.expiresAt = now() + ttlMs;
      return {
        attemptId: active.attemptId,
        url: active.url,
        code: active.code,
      };
    },
  });
}

export function createCodexLoginEventForwarder(
  dependencies: Readonly<{
    challenges: AssistantLoginChallengeRegistry;
    broadcast(event: DesktopStatusEvent): void;
  }>,
): (envelope: CodexLoginEventEnvelope) => void {
  return ({ attemptId, event }) => {
    if (!dependencies.challenges.isActive(attemptId)) return;
    if (event.kind === "progress") {
      dependencies.broadcast({
        type: "assistant-login",
        attemptId,
        event,
      });
      return;
    }
    if (event.kind === "status") {
      dependencies.challenges.invalidate(attemptId);
      dependencies.broadcast({
        type: "assistant-login",
        attemptId,
        event,
      });
      return;
    }
    const challenge = dependencies.challenges.record(attemptId, event);
    if (!challenge) return;
    dependencies.broadcast({
      type: "assistant-login",
      attemptId,
      event: {
        kind: "challenge",
        url: challenge.url,
        code: challenge.code,
      },
    });
  };
}

export const DESKTOP_IPC_CHANNELS = [
  "runtime:bootstrap",
  "google:status",
  "google:add-account",
  "google:clear-legacy-credentials",
  "google:reconnect-account",
  "google:disconnect-account",
  "google:sync-account",
  "google:sync-all",
  "assistant:status",
  "assistant:login",
  "assistant:open-login-url",
  "assistant:choose-codex-installation",
  "assistant:send",
  "assistant:cancel",
  "settings:get",
  "settings:patch",
  "settings:reset",
  "settings:import-legacy",
  "updates:status",
  "updates:check",
  "updates:install",
  "recovery:export",
  "recovery:list-backups",
  "recovery:restore",
  "recovery:reset",
] as const satisfies readonly IpcChannel[];

interface RendererRegistration {
  capabilities: ReadonlySet<RendererCapability>;
  frameToken: string;
  generation: number;
}

export class RendererIpcRegistry {
  private readonly generations = new Map<number, number>();
  private readonly registrations = new Map<number, RendererRegistration>();

  register(
    webContents: RegisteredRendererWebContents,
    capabilities: Iterable<RendererCapability>,
  ): number {
    const generation = (this.generations.get(webContents.id) ?? 0) + 1;
    this.generations.set(webContents.id, generation);
    this.registrations.set(webContents.id, {
      capabilities: new Set(capabilities),
      frameToken: webContents.mainFrame.frameToken,
      generation,
    });
    return generation;
  }

  unregister(webContentsId: number): void {
    this.registrations.delete(webContentsId);
  }

  authorize(event: RendererEvent, capability: RendererCapability): boolean {
    const registration = this.registrations.get(event.sender.id);
    const senderFrame = event.senderFrame;
    return (
      registration !== undefined &&
      senderFrame !== null &&
      event.sender.mainFrame === senderFrame &&
      registration.frameToken === senderFrame.frameToken &&
      registration.generation === this.generations.get(event.sender.id) &&
      registration.capabilities.has(capability) &&
      authorizeSender(senderFrame)
    );
  }
}

export function createRendererIpcRegistry(): RendererIpcRegistry {
  return new RendererIpcRegistry();
}

export function authorizeSender(frame: SenderFrame | undefined): boolean {
  if (frame?.parent !== null) return false;

  try {
    const url = new URL(frame.url);
    return (
      url.protocol === `${RENDERER_SCHEME}:` &&
      url.hostname === "renderer" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function createGoogleSyncIpcHandlers(
  broker: GoogleOAuthIpcBroker,
  supervisor: Readonly<{
    wake(trigger: "connection" | "manual", accountId?: string): void;
  }>,
  options: Readonly<{
    getSnapshot(): Promise<GoogleAccountsSnapshot>;
    reconcileAccounts(): Promise<void>;
    publish?(snapshot: GoogleAccountsSnapshot): void;
    subscribeStatus?(listener: () => void): () => void;
  }>,
): GoogleSyncIpcHandlerSet {
  const accountIdFromRequest = (request: unknown): string => {
    if (
      request === null ||
      typeof request !== "object" ||
      !("accountId" in request) ||
      typeof request.accountId !== "string"
    ) {
      throw new Error("GOOGLE_ACCOUNT_ID_REQUIRED");
    }
    return request.accountId;
  };
  let accepting = true;
  let disposed = false;
  let disposal: Promise<void> | null = null;
  const active = new Set<Promise<unknown>>();
  const publishSnapshot = async (): Promise<GoogleAccountsSnapshot> => {
    const snapshot = await options.getSnapshot();
    if (!accepting) throw new Error("RECOVERY_UNAVAILABLE");
    options.publish?.(snapshot);
    return snapshot;
  };
  const disposeStatus =
    options.subscribeStatus?.(() => {
      void publishSnapshot().catch(() => {});
    }) ?? (() => {});
  const unavailable = (): never => {
    throw new Error("RECOVERY_UNAVAILABLE");
  };
  const requireAvailable = () => {
    if (!accepting) unavailable();
  };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!accepting) return Promise.reject(new Error("RECOVERY_UNAVAILABLE"));
    const promise = operation();
    active.add(promise);
    void promise
      .finally(() => {
        active.delete(promise);
      })
      .catch(() => {});
    return promise;
  };
  const reconcileAndPublish = async (): Promise<GoogleAccountsSnapshot> => {
    requireAvailable();
    await options.reconcileAccounts();
    requireAvailable();
    return await publishSnapshot();
  };
  return {
    "google:add-account": () =>
      track(async () => {
        try {
          const connected = await broker.add();
          const snapshot = await reconcileAndPublish();
          supervisor.wake("connection", connected.accountId);
          return { kind: "completed", snapshot };
        } catch (error) {
          if (!accepting) unavailable();
          if (
            error instanceof Error &&
            (error.message === "GOOGLE_OAUTH_CANCELLED" ||
              error.message === "OAUTH_CALLBACK_CANCELLED")
          ) {
            return { kind: "cancelled", snapshot: await options.getSnapshot() };
          }
          if (
            error instanceof Error &&
            error.message === "GOOGLE_ACCOUNT_LIMIT_REACHED"
          ) {
            return {
              kind: "limit-reached",
              snapshot: await options.getSnapshot(),
            };
          }
          throw error;
        }
      }),
    "google:clear-legacy-credentials": () =>
      track(async () => {
        await broker.clearLegacyCredentials();
        return await reconcileAndPublish();
      }),
    "google:reconnect-account": (request) =>
      track(async () => {
        try {
          const connected = await broker.reconnect(
            accountIdFromRequest(request),
          );
          const snapshot = await reconcileAndPublish();
          supervisor.wake("connection", connected.accountId);
          return { kind: "completed", snapshot };
        } catch (error) {
          if (!accepting) unavailable();
          if (
            error instanceof Error &&
            error.message === "GOOGLE_OAUTH_CANCELLED"
          ) {
            return { kind: "cancelled", snapshot: await options.getSnapshot() };
          }
          throw error;
        }
      }),
    "google:disconnect-account": (request) =>
      track(async () => {
        await broker.disconnect(accountIdFromRequest(request));
        return await reconcileAndPublish();
      }),
    "google:status": async () => {
      requireAvailable();
      return await options.getSnapshot();
    },
    "google:sync-account": (request) =>
      track(async () => {
        supervisor.wake("manual", accountIdFromRequest(request));
        return await publishSnapshot();
      }),
    "google:sync-all": () =>
      track(async () => {
        supervisor.wake("manual");
        return await publishSnapshot();
      }),
    revoke() {
      accepting = false;
    },
    dispose() {
      accepting = false;
      if (disposal) return disposal;
      if (!disposed) {
        disposed = true;
        disposeStatus();
      }
      disposal = Promise.allSettled([...active]).then(() => undefined);
      return disposal;
    },
  };
}

export function createAssistantIpcHandlers(
  coordinator: Readonly<{
    send(request: unknown): Promise<unknown>;
    cancel(attemptId: string): Promise<void>;
    drain?(): Promise<void>;
  }>,
  runtime?: Readonly<{
    status(): Promise<AssistantProviderStatus>;
    login(attemptId: string, signal: AbortSignal): Promise<void>;
    cancel(attemptId: string): boolean | Promise<boolean>;
    close?(): Promise<void>;
  }>,
  login?: Readonly<{
    challenges: AssistantLoginChallengeRegistry;
    openUrl(url: string): Promise<void>;
  }>,
  chooseCodexInstallation?: () => Promise<ChooseCodexInstallationResult>,
): AssistantIpcHandlerSet {
  let accepting = true;
  let disposal: Promise<void> | null = null;
  const activeRequests = new Set<Promise<unknown>>();
  const loginChallenges =
    login?.challenges ?? createAssistantLoginChallengeRegistry();
  const pendingLogins = new Map<string, AbortController>();
  const loginCompletions = new Map<string, Promise<void>>();
  const requireAvailable = () => {
    if (!accepting) throw new Error("RECOVERY_UNAVAILABLE");
  };
  const track = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (!accepting) return Promise.reject(new Error("RECOVERY_UNAVAILABLE"));
    const promise = Promise.resolve().then(operation);
    activeRequests.add(promise);
    void promise
      .finally(() => {
        activeRequests.delete(promise);
      })
      .catch(() => {});
    return promise;
  };
  const handlers: AssistantIpcHandlers = {
    "assistant:status": async () =>
      accepting && runtime ? runtime.status() : { kind: "unavailable" },
    "assistant:login": () =>
      track(async () => {
        if (!runtime)
          return { kind: "rejected", status: { kind: "unavailable" } };
        const activeAttemptId = loginChallenges.activeAttemptId();
        if (activeAttemptId)
          return { kind: "started", attemptId: activeAttemptId };
        const status = await runtime.status();
        requireAvailable();
        if (status.kind !== "authentication-required") {
          return { kind: "rejected", status };
        }
        const concurrentAttemptId = loginChallenges.activeAttemptId();
        if (concurrentAttemptId) {
          return { kind: "started", attemptId: concurrentAttemptId };
        }
        const attemptId = assistantLoginAttemptIdSchema.parse(
          `login_${crypto.randomUUID().replaceAll("-", "")}`,
        );
        const controller = new AbortController();
        pendingLogins.set(attemptId, controller);
        loginChallenges.begin(attemptId);
        const completion = runtime
          .login(attemptId, controller.signal)
          .catch(() => {
            loginChallenges.invalidate(attemptId);
          })
          .finally(() => {
            pendingLogins.delete(attemptId);
            loginCompletions.delete(attemptId);
          });
        loginCompletions.set(attemptId, completion);
        void completion;
        return { kind: "started", attemptId };
      }),
    "assistant:open-login-url": (request) =>
      track(async () => {
        if (!login) throw new Error("Assistant login challenge is not active");
        await login.openUrl(
          loginChallenges.consume(request as AssistantOpenLoginRequest),
        );
      }),
    "assistant:choose-codex-installation": () =>
      track(() => chooseCodexInstallation?.() ?? { kind: "missing" as const }),
    "assistant:send": (request) =>
      track(async () => {
        const status = runtime
          ? await runtime.status()
          : { kind: "unavailable" as const };
        requireAvailable();
        if (status.kind !== "ready" && status.kind !== "ready-degraded") {
          const reason =
            status.kind === "authentication-required"
              ? "authentication-required"
              : status.kind === "needs-reprobe"
                ? "needs-reprobe"
                : status.kind === "incompatible"
                  ? "incompatible"
                  : status.kind === "probe-failed"
                    ? "probe-failed"
                    : status.kind === "probing"
                      ? "probing"
                      : "unavailable";
          return { kind: "rejected", reason };
        }
        return coordinator.send(request);
      }),
    "assistant:cancel": (request) =>
      track(() => {
        const attemptId = (request as { attemptId: string }).attemptId;
        loginChallenges.invalidate(attemptId);
        if (assistantLoginAttemptIdSchema.safeParse(attemptId).success) {
          pendingLogins.get(attemptId)?.abort();
          runtime?.cancel(attemptId);
          return undefined;
        }
        if (!assistantCoordinatorAttemptIdSchema.safeParse(attemptId).success) {
          throw new Error("Assistant attempt identity is invalid");
        }
        return coordinator.cancel(attemptId);
      }),
  };
  return Object.assign(handlers, {
    revoke() {
      accepting = false;
    },
    dispose() {
      accepting = false;
      if (disposal) return disposal;
      disposal = (async () => {
        const activeAttemptId = loginChallenges.activeAttemptId();
        if (activeAttemptId) loginChallenges.invalidate(activeAttemptId);
        for (const [attemptId, controller] of pendingLogins) {
          controller.abort();
          runtime?.cancel(attemptId);
        }
        const coordinatorDrain = coordinator.drain?.();
        await Promise.allSettled([
          ...activeRequests,
          ...loginCompletions.values(),
          ...(coordinatorDrain ? [coordinatorDrain] : []),
        ]);
        await runtime?.close?.();
      })();
      return disposal;
    },
  });
}

export function createRecoveryIpcHandlers(
  recovery: Readonly<{
    exportData(): Promise<unknown>;
    listBackups(): Promise<unknown>;
    restore(backupId: string): Promise<void>;
    reset(): Promise<void>;
  }>,
): RecoveryIpcHandlers {
  return {
    "recovery:export": () => recovery.exportData(),
    "recovery:list-backups": () => recovery.listBackups(),
    "recovery:restore": async (request) => {
      const backupId = (request as { backupId: string }).backupId;
      await recovery.restore(backupId);
      return { kind: "restored", backupId, restartRequired: true };
    },
    "recovery:reset": async () => {
      await recovery.reset();
      return { kind: "reset", restartRequired: true };
    },
  };
}

export function createSettingsIpcHandlers(
  store: Readonly<{
    snapshot(): SettingsSnapshot;
    patch(request: SettingsPatchRequest): Promise<SettingsWriteResult>;
    reset(request: SettingsResetRequest): Promise<SettingsWriteResult>;
    importLegacy(
      request: LegacySettingsImportRequest,
    ): Promise<SettingsWriteResult>;
  }>,
): SettingsIpcHandlers {
  return {
    "settings:get": () => store.snapshot(),
    "settings:patch": (request) => store.patch(request as SettingsPatchRequest),
    "settings:reset": (request) => store.reset(request as SettingsResetRequest),
    "settings:import-legacy": (request) =>
      store.importLegacy(request as LegacySettingsImportRequest),
  };
}

export function subscribeSettingsChanges(
  store: Readonly<{
    subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
  }>,
  publish: (event: unknown) => void,
): () => void {
  return store.subscribe((snapshot) => {
    publish(
      desktopStatusEventSchema.parse({
        type: "settings-changed",
        snapshot,
      }),
    );
  });
}

export function createDesktopIpcHandlers(
  options: Readonly<{
    bootstrap(): Promise<unknown>;
    google: GoogleSyncIpcHandlers;
    assistant?: AssistantIpcHandlers;
    settings: SettingsIpcHandlers;
    updates?: UpdateIpcHandlers;
    recovery?: RecoveryIpcHandlers;
  }>,
): DesktopIpcHandlers {
  const assistant: AssistantIpcHandlers = options.assistant ?? {
    "assistant:status": () => ({ kind: "unavailable" }),
    "assistant:login": () => ({
      kind: "rejected",
      status: { kind: "unavailable" },
    }),
    "assistant:open-login-url": () => undefined,
    "assistant:choose-codex-installation": () => ({ kind: "missing" }),
    "assistant:send": () => ({ kind: "rejected", reason: "unavailable" }),
    "assistant:cancel": () => undefined,
  };
  const recovery: RecoveryIpcHandlers = options.recovery ?? {
    "recovery:export": () => ({ kind: "cancelled" }),
    "recovery:list-backups": () => [],
    "recovery:restore": () => {
      throw new Error("Recovery is unavailable");
    },
    "recovery:reset": () => {
      throw new Error("Recovery is unavailable");
    },
  };
  const updates: UpdateIpcHandlers = options.updates ?? {
    "updates:status": () => ({
      kind: "disabled",
      currentVersion: "0.0.0",
      reason: "development",
    }),
    "updates:check": () => ({
      kind: "disabled",
      currentVersion: "0.0.0",
      reason: "development",
    }),
    "updates:install": () => ({ kind: "restarting" }),
  };
  return {
    "runtime:bootstrap": () => options.bootstrap(),
    ...options.google,
    ...assistant,
    ...options.settings,
    ...updates,
    ...recovery,
  };
}

export function registerDesktopIpc(
  ipcMain: Pick<IpcMain, "handle">,
  handlers: DesktopIpcHandlers,
  registry: RendererIpcRegistry,
): void {
  for (const channel of DESKTOP_IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!registry.authorize(event, channel)) {
        throw new Error("Unauthorized desktop IPC sender");
      }

      const request = parseIpcRequest(channel, payload);
      const result = await handlers[channel](request, event);
      return parseIpcResult(channel, result);
    });
  }
}
