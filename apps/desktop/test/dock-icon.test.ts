import { describe, expect, test } from "bun:test";

import { qaliDockIconPath, refreshMacDockIcon } from "../src/main/dock-icon";

describe("Qali Dock icon", () => {
  test("loads the release-owned PNG from Resources in packaged builds", () => {
    expect(
      qaliDockIconPath({
        appPath: "/Applications/Qali.app/Contents/Resources/app.asar",
        isPackaged: true,
        resourcesPath: "/Applications/Qali.app/Contents/Resources",
      }),
    ).toBe("/Applications/Qali.app/Contents/Resources/qali-icon.png");
  });

  test("refreshes the macOS Dock from that explicit artwork", () => {
    const icons: string[] = [];

    refreshMacDockIcon({
      dock: { setIcon: (path) => icons.push(path) },
      iconPath: "/Applications/Qali.app/Contents/Resources/qali-icon.png",
      platform: "darwin",
    });

    expect(icons).toEqual([
      "/Applications/Qali.app/Contents/Resources/qali-icon.png",
    ]);
  });

  test("does not use the macOS-only Dock API on other platforms", () => {
    const icons: string[] = [];

    refreshMacDockIcon({
      dock: { setIcon: (path) => icons.push(path) },
      iconPath: "/release/qali-icon.png",
      platform: "linux",
    });

    expect(icons).toEqual([]);
  });

  test("keeps startup alive when macOS rejects the icon refresh", () => {
    expect(
      refreshMacDockIcon({
        dock: {
          setIcon: () => {
            throw new Error("unreadable icon");
          },
        },
        iconPath: "/Applications/Qali.app/Contents/Resources/qali-icon.png",
        platform: "darwin",
      }),
    ).toBe(false);
  });
});
