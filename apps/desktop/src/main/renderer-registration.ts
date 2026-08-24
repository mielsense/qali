import { EXTERNAL_PRODUCT_LINK_CHANNEL } from "./external-links";
import {
  DESKTOP_IPC_CHANNELS,
  type RegisteredRendererWebContents,
  type RendererIpcRegistry,
} from "./ipc/router";

type RendererDocumentWebContents = RegisteredRendererWebContents & {
  send(channel: string): void;
};

export function registerRendererDocument(
  registry: RendererIpcRegistry,
  webContents: RendererDocumentWebContents,
): void {
  registry.register(webContents, [
    ...DESKTOP_IPC_CHANNELS,
    EXTERNAL_PRODUCT_LINK_CHANNEL,
  ]);
  webContents.send("desktop:ready");
}

/** Same-document SPA navigation keeps the exact registered document/frame.
 * Revoke only when Electron is replacing the main document; an in-place
 * navigation has no matching did-frame-finish-load registration event. */
export function handleRendererNavigationStarted(
  registry: RendererIpcRegistry,
  webContentsId: number,
  navigation: Readonly<{ isInPlace: boolean; isMainFrame: boolean }>,
): void {
  if (navigation.isMainFrame && !navigation.isInPlace) {
    registry.unregister(webContentsId);
  }
}
