import {
  desktopStatusEventSchema,
  parseIpcRequest,
  parseIpcResult,
  type AssistantAttemptId,
  type AssistantSendRequest,
  type AssistantOpenLoginRequest,
  type ChooseCodexInstallationResult,
  type DesktopStatusEvent,
  type GoogleAccountId,
  type IpcChannel,
  type LegacySettingsImportRequest,
  type SettingsPatchRequest,
  type SettingsResetRequest,
} from "@qali/desktop-contracts/schemas";
import type { QaliDesktopApi } from "@qali/desktop-contracts";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  EXTERNAL_PRODUCT_LINK_CHANNEL,
  trustedExternalLinkFromClick,
} from "../main/external-links";
import { createPreloadReadiness } from "./readiness";

const readiness = createPreloadReadiness();
ipcRenderer.once("desktop:ready", () => readiness.markReady());

function invoke<C extends IpcChannel>(channel: C, payload: unknown) {
  return readiness
    .run(() => ipcRenderer.invoke(channel, parseIpcRequest(channel, payload)))
    .then((result) => parseIpcResult(channel, result));
}

function subscribe(listener: (event: DesktopStatusEvent) => void): () => void {
  const onStatus = (_event: IpcRendererEvent, payload: unknown) => {
    listener(desktopStatusEventSchema.parse(payload));
  };
  ipcRenderer.on("desktop:status", onStatus);
  return () => ipcRenderer.removeListener("desktop:status", onStatus);
}

document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const link = target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;

    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (url.protocol !== "https:") return;

    event.preventDefault();
    const href = trustedExternalLinkFromClick(event.isTrusted, link.href);
    if (href !== null) ipcRenderer.send(EXTERNAL_PRODUCT_LINK_CHANNEL, href);
  },
  { capture: true },
);

type QaliDesktopApiWithCodexChooser = Omit<QaliDesktopApi, "assistant"> & {
  assistant: QaliDesktopApi["assistant"] & {
    chooseCodexInstallation(): Promise<ChooseCodexInstallationResult>;
  };
};

contextBridge.exposeInMainWorld("qali", {
  runtime: { bootstrap: () => invoke("runtime:bootstrap", {}) },
  google: {
    status: () => invoke("google:status", {}),
    addAccount: () => invoke("google:add-account", {}),
    reconnectAccount: (accountId: GoogleAccountId) =>
      invoke("google:reconnect-account", { accountId }),
    disconnectAccount: (accountId: GoogleAccountId) =>
      invoke("google:disconnect-account", { accountId }),
    syncAccount: (accountId: GoogleAccountId) =>
      invoke("google:sync-account", { accountId }),
    syncAll: () => invoke("google:sync-all", {}),
    clearLegacyCredentials: () => invoke("google:clear-legacy-credentials", {}),
  },
  assistant: {
    status: () => invoke("assistant:status", {}),
    login: () => invoke("assistant:login", {}),
    openLoginUrl: (request: AssistantOpenLoginRequest) =>
      invoke("assistant:open-login-url", request),
    chooseCodexInstallation: () =>
      invoke("assistant:choose-codex-installation", {}),
    send: (request: AssistantSendRequest) => invoke("assistant:send", request),
    cancel: (attemptId: AssistantAttemptId) =>
      invoke("assistant:cancel", { attemptId }),
  },
  settings: {
    get: () => invoke("settings:get", {}),
    patch: (request: SettingsPatchRequest) => invoke("settings:patch", request),
    reset: (request: SettingsResetRequest) => invoke("settings:reset", request),
    importLegacy: (request: LegacySettingsImportRequest) =>
      invoke("settings:import-legacy", request),
  },
  updates: {
    status: () => invoke("updates:status", {}),
    check: () => invoke("updates:check", {}),
    install: () => invoke("updates:install", {}),
  },
  recovery: {
    exportData: () => invoke("recovery:export", {}),
    listBackups: () => invoke("recovery:list-backups", {}),
    restore: (backupId: string) => invoke("recovery:restore", { backupId }),
    reset: () => invoke("recovery:reset", {}),
  },
  events: { subscribe },
} satisfies QaliDesktopApiWithCodexChooser);
