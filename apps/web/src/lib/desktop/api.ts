import {
  desktopBootstrapSchema,
  desktopStatusEventSchema,
  googleAccountsSnapshotSchema,
  googleAddAccountResultSchema,
  googleReconnectAccountResultSchema,
  settingsSnapshotSchema,
  settingsWriteResultSchema,
  desktopUpdateStateSchema,
  updateInstallResultSchema,
} from "@qali/desktop-contracts/schemas";
import type {
  DesktopBootstrap,
  DesktopStatusEvent,
  DesktopUpdateState,
  GoogleAccountId,
  GoogleAccountsSnapshot,
  GoogleAddAccountResult,
  GoogleReconnectAccountResult,
  LegacySettingsImportRequest,
  QaliDesktopApi,
  SettingsPatchRequest,
  SettingsResetRequest,
  SettingsSnapshot,
  SettingsWriteResult,
  UpdateInstallResult,
} from "@qali/desktop-contracts";

const LOCAL_CONVEX_HOST = "127.0.0.1";
const LOCAL_CONVEX_AUDIENCE = "qali-local-convex";

export type DesktopWindow = { qali?: unknown };

export type DesktopRendererApi = Readonly<{
  bootstrap(): Promise<DesktopBootstrap>;
  googleStatus(): Promise<GoogleAccountsSnapshot>;
  addGoogleAccount(): Promise<GoogleAddAccountResult>;
  reconnectGoogleAccount(
    accountId: GoogleAccountId,
  ): Promise<GoogleReconnectAccountResult>;
  disconnectGoogleAccount(
    accountId: GoogleAccountId,
  ): Promise<GoogleAccountsSnapshot>;
  syncGoogleAccount(
    accountId: GoogleAccountId,
  ): Promise<GoogleAccountsSnapshot>;
  syncAllGoogleAccounts(): Promise<GoogleAccountsSnapshot>;
  clearLegacyGoogleCredentials(): Promise<GoogleAccountsSnapshot>;
  settingsGet(): Promise<SettingsSnapshot>;
  settingsPatch(request: SettingsPatchRequest): Promise<SettingsWriteResult>;
  settingsReset(request: SettingsResetRequest): Promise<SettingsWriteResult>;
  settingsImportLegacy(
    request: LegacySettingsImportRequest,
  ): Promise<SettingsWriteResult>;
  updateStatus(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<UpdateInstallResult>;
  subscribe(listener: (event: DesktopStatusEvent) => void): () => void;
}>;

/** Mark the installed renderer so shared calendar chrome can reserve the native
 * macOS traffic-light area. Hosted web keeps its ordinary full-width header. */
export function applyDesktopDocumentChrome(
  root: HTMLElement,
  desktop: boolean,
): void {
  if (desktop) root.dataset.qaliDesktop = "";
  else delete root.dataset.qaliDesktop;
}

function ownsDesktopBridge(windowValue: DesktopWindow): boolean {
  return Object.prototype.hasOwnProperty.call(windowValue, "qali");
}

function assertDesktopBridge(value: unknown): asserts value is QaliDesktopApi {
  if (value === null || typeof value !== "object") {
    throw new Error("Desktop preload bridge is malformed");
  }
  const bridge = value as Record<string, unknown>;
  const methodGroups = {
    runtime: ["bootstrap"],
    google: [
      "status",
      "addAccount",
      "reconnectAccount",
      "disconnectAccount",
      "syncAccount",
      "syncAll",
      "clearLegacyCredentials",
    ],
    assistant: ["status", "login", "openLoginUrl", "send", "cancel"],
    settings: ["get", "patch", "reset", "importLegacy"],
    updates: ["status", "check", "install"],
    recovery: ["exportData", "listBackups", "restore", "reset"],
    events: ["subscribe"],
  } as const;
  for (const [groupName, methodNames] of Object.entries(methodGroups)) {
    const group = bridge[groupName];
    if (group === null || typeof group !== "object") {
      throw new Error("Desktop preload bridge is malformed");
    }
    for (const methodName of methodNames) {
      if (
        typeof (group as Record<string, unknown>)[methodName] !== "function"
      ) {
        throw new Error("Desktop preload bridge is malformed");
      }
    }
  }
}

function decodeBase64UrlJson(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(atob(padded));
}

function assertRendererToken(token: string): void {
  const segments = token.split(".");
  if (
    segments.length !== 3 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new Error("Desktop bootstrap renderer token is malformed");
  }
  let payload: unknown;
  try {
    payload = decodeBase64UrlJson(segments[1]!);
  } catch {
    throw new Error("Desktop bootstrap renderer token is malformed");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).role !== "renderer" ||
    (payload as Record<string, unknown>).aud !== LOCAL_CONVEX_AUDIENCE ||
    typeof (payload as Record<string, unknown>).exp !== "number" ||
    typeof (payload as Record<string, unknown>).iat !== "number" ||
    typeof (payload as Record<string, unknown>).iss !== "string" ||
    typeof (payload as Record<string, unknown>).sub !== "string"
  ) {
    throw new Error("Desktop bootstrap renderer token is not renderer-scoped");
  }
}

function assertLocalConvexUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== LOCAL_CONVEX_HOST ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Desktop bootstrap Convex URL is not an exact local origin",
    );
  }
}

function parseBootstrap(value: unknown): DesktopBootstrap {
  const bootstrap = desktopBootstrapSchema.parse(value);
  assertLocalConvexUrl(bootstrap.convexUrl);
  assertRendererToken(bootstrap.rendererAuthToken);
  return Object.freeze(bootstrap);
}

export function desktopEnvironmentFor(
  windowValue: DesktopWindow,
): "desktop" | "web" {
  return ownsDesktopBridge(windowValue) ? "desktop" : "web";
}

export function desktopApiFor(
  windowValue: DesktopWindow | undefined = typeof window === "undefined"
    ? undefined
    : window,
): DesktopRendererApi | null {
  if (windowValue === undefined || !ownsDesktopBridge(windowValue)) return null;
  assertDesktopBridge(windowValue.qali);
  return createDesktopApi(windowValue.qali);
}

export function createDesktopApi(bridge: QaliDesktopApi): DesktopRendererApi {
  return Object.freeze({
    async bootstrap() {
      return parseBootstrap(await bridge.runtime.bootstrap());
    },
    async googleStatus() {
      return googleAccountsSnapshotSchema.parse(await bridge.google.status());
    },
    async addGoogleAccount() {
      return googleAddAccountResultSchema.parse(
        await bridge.google.addAccount(),
      );
    },
    async reconnectGoogleAccount(accountId) {
      return googleReconnectAccountResultSchema.parse(
        await bridge.google.reconnectAccount(accountId),
      );
    },
    async disconnectGoogleAccount(accountId) {
      return googleAccountsSnapshotSchema.parse(
        await bridge.google.disconnectAccount(accountId),
      );
    },
    async syncGoogleAccount(accountId) {
      return googleAccountsSnapshotSchema.parse(
        await bridge.google.syncAccount(accountId),
      );
    },
    async syncAllGoogleAccounts() {
      return googleAccountsSnapshotSchema.parse(await bridge.google.syncAll());
    },
    async clearLegacyGoogleCredentials() {
      return googleAccountsSnapshotSchema.parse(
        await bridge.google.clearLegacyCredentials(),
      );
    },
    async settingsGet() {
      return settingsSnapshotSchema.parse(await bridge.settings.get());
    },
    async settingsPatch(request) {
      return settingsWriteResultSchema.parse(
        await bridge.settings.patch(request),
      );
    },
    async settingsReset(request) {
      return settingsWriteResultSchema.parse(
        await bridge.settings.reset(request),
      );
    },
    async settingsImportLegacy(request) {
      return settingsWriteResultSchema.parse(
        await bridge.settings.importLegacy(request),
      );
    },
    async updateStatus() {
      return desktopUpdateStateSchema.parse(await bridge.updates.status());
    },
    async checkForUpdates() {
      return desktopUpdateStateSchema.parse(await bridge.updates.check());
    },
    async installUpdate() {
      return updateInstallResultSchema.parse(await bridge.updates.install());
    },
    subscribe(listener) {
      return bridge.events.subscribe((event) =>
        listener(desktopStatusEventSchema.parse(event)),
      );
    },
  });
}

declare global {
  interface Window {
    qali?: QaliDesktopApi;
  }
}
