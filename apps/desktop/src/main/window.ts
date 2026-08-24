import { BrowserWindow } from "electron";

import type { RendererIpcRegistry } from "./ipc/router";
import { resolvePreloadPath } from "./preload-path";
import { RENDERER_ORIGIN } from "./protocol";
import {
  handleRendererNavigationStarted,
  registerRendererDocument,
} from "./renderer-registration";
import { mainWindowOptions } from "./window-options";

const PRELOAD_PATH = resolvePreloadPath(import.meta.url);

export function createMainWindow(registry: RendererIpcRegistry): BrowserWindow {
  const window = new BrowserWindow({
    ...mainWindowOptions(),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  const { webContents } = window;
  const { session } = webContents;
  webContents.on("will-navigate", (event) => event.preventDefault());
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    handleRendererNavigationStarted(registry, webContents.id, {
      isInPlace,
      isMainFrame,
    });
  });
  webContents.on("did-frame-finish-load", (_event, isMainFrame) => {
    if (isMainFrame) {
      registerRendererDocument(registry, webContents);
    }
  });
  session.on("will-download", (event) => event.preventDefault());
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${RENDERER_ORIGIN}/`);
  return window;
}
