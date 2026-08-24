import type { QaliPaths } from "./paths";

type FocusableWindow = {
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
};

type SingleInstanceApplication = {
  on(event: "second-instance", listener: () => void): unknown;
  requestSingleInstanceLock(additionalData?: Record<string, string>): boolean;
  setPath(name: "userData", path: string): void;
};

export function focusExistingWindow(
  getWindows: () => FocusableWindow[],
): void {
  const window = getWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function acquireWriterLock(
  paths: QaliPaths,
  application: SingleInstanceApplication,
  getWindows: () => FocusableWindow[],
): boolean {
  // Chromium's ProcessSingleton lock is scoped by userData and owned by the OS.
  // The diagnostic path is deliberately not consulted for ownership decisions.
  application.setPath("userData", paths.root);
  const acquired = application.requestSingleInstanceLock({ root: paths.root });
  if (acquired) {
    application.on("second-instance", () => focusExistingWindow(getWindows));
  }
  return acquired;
}
