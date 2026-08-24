import { join, resolve } from "node:path";

type DockIconTarget = Readonly<{
  setIcon(iconPath: string): void;
}>;

export function qaliDockIconPath(options: {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "qali-icon.png")
    : resolve(options.appPath, "../web/public/icon-512.png");
}

export function refreshMacDockIcon(options: {
  dock?: DockIconTarget;
  iconPath: string;
  platform: NodeJS.Platform;
}): boolean {
  if (options.platform !== "darwin" || !options.dock) return false;

  try {
    options.dock.setIcon(options.iconPath);
    return true;
  } catch {
    // The bundle icon remains the source of truth. A stale or unreadable
    // runtime refresh must never prevent the desktop app from starting.
    return false;
  }
}
