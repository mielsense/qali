import type { IpcMain, IpcMainEvent } from "electron";

import type { RendererIpcRegistry } from "./ipc/router";

export const EXTERNAL_PRODUCT_LINK_CHANNEL = "desktop:open-product-link" as const;

const EXTERNAL_PRODUCT_HOSTS = new Set([
  "calendar.google.com",
  "calendar.myqali.com",
  "www.google.com",
]);

export function trustedExternalLinkFromClick(
  isTrusted: boolean,
  href: string,
): string | null {
  return isTrusted ? href : null;
}

export function isAllowedExternalProductUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      EXTERNAL_PRODUCT_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isAllowedAssistantLoginUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return (
      url.protocol === "https:" &&
      url.hostname === "auth.openai.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function registerExternalProductLinks(
  ipcMain: Pick<IpcMain, "on">,
  registry: RendererIpcRegistry,
  openExternal: (url: string) => Promise<void>,
): void {
  ipcMain.on(EXTERNAL_PRODUCT_LINK_CHANNEL, (event: IpcMainEvent, value: unknown) => {
    if (
      !registry.authorize(event, EXTERNAL_PRODUCT_LINK_CHANNEL) ||
      typeof value !== "string" ||
      !isAllowedExternalProductUrl(value)
    ) {
      return;
    }

    void openExternal(value);
  });
}
