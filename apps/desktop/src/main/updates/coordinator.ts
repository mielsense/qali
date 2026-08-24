import type {
  DesktopUpdateState,
  UpdateInstallResult,
} from "@qali/desktop-contracts";
import type { AppUpdater } from "electron-updater";

type Timer = ReturnType<typeof setTimeout>;

export type DesktopUpdateCoordinator = Readonly<{
  check(): Promise<DesktopUpdateState>;
  dispose(): void;
  install(): Promise<UpdateInstallResult>;
  installIfRequested(): boolean;
  scheduleAutomaticCheck(delayMs?: number): void;
  snapshot(): DesktopUpdateState;
}>;

const AUTOMATIC_CHECK_DELAY_MS = 20_000;

export function completeUpdateAwareShutdown(options: {
  coordinator: Pick<
    DesktopUpdateCoordinator,
    "dispose" | "installIfRequested"
  > | null;
  quit(): void;
}): "installing" | "quit" {
  try {
    if (options.coordinator?.installIfRequested()) return "installing";
  } catch {
    // A failed installer launch must not strand Qali after services drained.
  }
  options.coordinator?.dispose();
  options.quit();
  return "quit";
}

function boundedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

export function createDesktopUpdateCoordinator(
  options: Readonly<{
    currentVersion: string;
    disabledReason?: "development" | "packaged-smoke" | "release-policy";
    enabled: boolean;
    now?: () => Date;
    publish(state: DesktopUpdateState): void;
    requestQuit(): void;
    setTimer?: typeof setTimeout;
    updater: AppUpdater;
  }>,
): DesktopUpdateCoordinator {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? setTimeout;
  let automaticCheckTimer: Timer | null = null;
  let installRequested = false;
  let state: DesktopUpdateState = options.enabled
    ? { kind: "idle", currentVersion: options.currentVersion }
    : {
        kind: "disabled",
        currentVersion: options.currentVersion,
        reason: options.disabledReason ?? "release-policy",
      };

  const transition = (next: DesktopUpdateState) => {
    state = Object.freeze(next);
    options.publish(state);
  };

  const onChecking = () => {
    transition({ kind: "checking", currentVersion: options.currentVersion });
  };
  const onUnavailable = () => {
    transition({
      kind: "current",
      currentVersion: options.currentVersion,
      checkedAt: now().toISOString(),
    });
  };
  const onAvailable = (info: Readonly<{ version: string }>) => {
    transition({
      kind: "downloading",
      currentVersion: options.currentVersion,
      version: info.version,
      percent: 0,
    });
  };
  const onProgress = (progress: Readonly<{ percent: number }>) => {
    if (state.kind !== "downloading") return;
    transition({ ...state, percent: boundedPercent(progress.percent) });
  };
  const onDownloaded = (info: Readonly<{ version: string }>) => {
    transition({
      kind: "ready",
      currentVersion: options.currentVersion,
      version: info.version,
    });
  };
  const onError = () => {
    if (!options.enabled || state.kind === "ready") return;
    transition({
      kind: "error",
      currentVersion: options.currentVersion,
      message: "Qali could not check for updates. Try again later.",
    });
  };

  if (options.enabled) {
    options.updater.autoDownload = true;
    options.updater.autoInstallOnAppQuit = false;
    options.updater.autoRunAppAfterInstall = true;
    options.updater.allowPrerelease = false;
    options.updater.allowDowngrade = false;
    options.updater.logger = null;
    options.updater.on("checking-for-update", onChecking);
    options.updater.on("update-not-available", onUnavailable);
    options.updater.on("update-available", onAvailable);
    options.updater.on("download-progress", onProgress);
    options.updater.on("update-downloaded", onDownloaded);
    options.updater.on("error", onError);
  }

  const check = async (): Promise<DesktopUpdateState> => {
    if (!options.enabled) return state;
    if (
      state.kind === "checking" ||
      state.kind === "downloading" ||
      state.kind === "ready"
    ) {
      return state;
    }
    onChecking();
    try {
      const result = await options.updater.checkForUpdates();
      if (result === null) onError();
    } catch {
      onError();
    }
    return state;
  };

  const coordinator: DesktopUpdateCoordinator = {
    check,
    dispose() {
      if (automaticCheckTimer) clearTimeout(automaticCheckTimer);
      automaticCheckTimer = null;
      if (!options.enabled) return;
      options.updater.removeListener("checking-for-update", onChecking);
      options.updater.removeListener("update-not-available", onUnavailable);
      options.updater.removeListener("update-available", onAvailable);
      options.updater.removeListener("download-progress", onProgress);
      options.updater.removeListener("update-downloaded", onDownloaded);
      options.updater.removeListener("error", onError);
    },
    async install(): Promise<UpdateInstallResult> {
      if (state.kind !== "ready") {
        throw new Error("UPDATE_NOT_READY");
      }
      installRequested = true;
      queueMicrotask(options.requestQuit);
      return { kind: "restarting" };
    },
    installIfRequested() {
      if (!installRequested || state.kind !== "ready") return false;
      installRequested = false;
      options.updater.quitAndInstall(false, true);
      return true;
    },
    scheduleAutomaticCheck(delayMs = AUTOMATIC_CHECK_DELAY_MS) {
      if (!options.enabled || automaticCheckTimer) return;
      automaticCheckTimer = setTimer(() => {
        automaticCheckTimer = null;
        void check();
      }, delayMs);
      automaticCheckTimer.unref?.();
    },
    snapshot: () => state,
  };
  return Object.freeze(coordinator);
}
