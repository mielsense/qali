import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { AppUpdater } from "electron-updater";

import {
  completeUpdateAwareShutdown,
  createDesktopUpdateCoordinator,
} from "../src/main/updates/coordinator";
import {
  desktopUpdatesEnabled,
  loadDesktopUpdatePolicy,
} from "../src/main/updates/policy";

class FakeUpdater extends EventEmitter {
  allowDowngrade = true;
  allowPrerelease = true;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  logger: unknown = {};
  checks = 0;
  installs = 0;

  async checkForUpdates() {
    this.checks += 1;
    this.emit("checking-for-update");
    return {};
  }

  quitAndInstall() {
    this.installs += 1;
  }
}

function updaterPort(fake: FakeUpdater): AppUpdater {
  return fake as unknown as AppUpdater;
}

describe("desktop update coordinator", () => {
  test("fails closed when the signed release policy is absent", async () => {
    expect(
      await loadDesktopUpdatePolicy("/not/a/qali/update-policy.json"),
    ).toBeNull();
    expect(
      desktopUpdatesEnabled({
        isPackaged: true,
        packagedSmoke: false,
        platform: "darwin",
        policy: null,
      }),
    ).toBe(false);
  });

  test("keeps development builds disabled without touching the updater", async () => {
    const updater = new FakeUpdater();
    const coordinator = createDesktopUpdateCoordinator({
      currentVersion: "0.1.0",
      disabledReason: "development",
      enabled: false,
      publish: () => undefined,
      requestQuit: () => undefined,
      updater: updaterPort(updater),
    });

    expect(await coordinator.check()).toEqual({
      kind: "disabled",
      currentVersion: "0.1.0",
      reason: "development",
    });
    expect(updater.checks).toBe(0);
  });

  test("publishes bounded progress and installs only after coordinated shutdown", async () => {
    const updater = new FakeUpdater();
    const states: string[] = [];
    let quitRequests = 0;
    const coordinator = createDesktopUpdateCoordinator({
      currentVersion: "0.1.0",
      enabled: true,
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      publish: (state) => states.push(state.kind),
      requestQuit: () => {
        quitRequests += 1;
      },
      updater: updaterPort(updater),
    });

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    await coordinator.check();
    updater.emit("update-available", { version: "0.2.0" });
    updater.emit("download-progress", { percent: 148.27 });
    expect(coordinator.snapshot()).toEqual({
      kind: "downloading",
      currentVersion: "0.1.0",
      version: "0.2.0",
      percent: 100,
    });
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(await coordinator.install()).toEqual({ kind: "restarting" });
    await Promise.resolve();
    expect(quitRequests).toBe(1);
    expect(updater.installs).toBe(0);
    expect(coordinator.installIfRequested()).toBe(true);
    expect(updater.installs).toBe(1);
    expect(states).toContain("ready");
  });

  test("redacts provider errors", () => {
    const updater = new FakeUpdater();
    const coordinator = createDesktopUpdateCoordinator({
      currentVersion: "0.1.0",
      enabled: true,
      publish: () => undefined,
      requestQuit: () => undefined,
      updater: updaterPort(updater),
    });

    updater.emit("error", new Error("token=super-secret feed=https://private"));
    expect(coordinator.snapshot()).toEqual({
      kind: "error",
      currentVersion: "0.1.0",
      message: "Qali could not check for updates. Try again later.",
    });
  });

  test("falls back to a normal quit when the installer cannot launch", () => {
    let disposed = 0;
    let normalQuits = 0;

    expect(
      completeUpdateAwareShutdown({
        coordinator: {
          dispose: () => {
            disposed += 1;
          },
          installIfRequested: () => {
            throw new Error("installer unavailable");
          },
        },
        quit: () => {
          normalQuits += 1;
        },
      }),
    ).toBe("quit");
    expect(disposed).toBe(1);
    expect(normalQuits).toBe(1);
  });
});
