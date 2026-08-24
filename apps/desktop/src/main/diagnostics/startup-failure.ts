import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ConvexSupervisorError } from "../convex/supervisor";
import { redactDiagnostic } from "./redaction";

const STARTUP_FAILURE_LOG = "desktop-startup.log";

export const DESKTOP_STARTUP_STAGES = Object.freeze([
  "not-created",
  "settings",
  "recovery",
  "auth",
  "convex",
  "google-accounts",
  "google-detached-migration",
  "google-account-attach",
  "google-account-migration",
  "google-account-audit",
  "migration",
  "restore-finalization",
  "google-worker",
  "renderer-protocol",
  "update-policy",
  "desktop-handlers",
  "assistant",
  "recovery-handlers",
  "ipc",
  "window",
  "healthy",
] as const);

export type DesktopStartupStage = (typeof DESKTOP_STARTUP_STAGES)[number];

const DESKTOP_STARTUP_STAGE_SET = new Set<string>(DESKTOP_STARTUP_STAGES);

export function safeDesktopStartupStage(value: unknown): DesktopStartupStage {
  return typeof value === "string" && DESKTOP_STARTUP_STAGE_SET.has(value)
    ? (value as DesktopStartupStage)
    : "not-created";
}

const SAFE_CAUSE_CODES = Object.freeze([
  [/source changed during backup/i, "BACKUP_SOURCE_CHANGED"],
  [/settings document is unavailable/i, "BACKUP_SETTINGS_MISSING"],
  [/readiness probe timed out/i, "BACKEND_READINESS_TIMEOUT"],
  [/ownership receipt could not be secured/i, "BACKEND_OWNERSHIP_FAILED"],
  [/verified orphaned local calendar service did not stop/i, "BACKEND_ORPHAN_STOP_FAILED"],
  [/deployment credential is unavailable/i, "BACKEND_DEPLOY_CREDENTIAL_MISSING"],
  [/GOOGLE_ACCOUNT_MIGRATION_POSTCONDITION_CALENDARS/, "GOOGLE_MIGRATION_CALENDARS_INVALID"],
  [/GOOGLE_ACCOUNT_MIGRATION_POSTCONDITION_EVENTS/, "GOOGLE_MIGRATION_EVENTS_INVALID"],
  [/GOOGLE_ACCOUNT_MIGRATION_POSTCONDITION_RECURRING_SERIES/, "GOOGLE_MIGRATION_RECURRING_SERIES_INVALID"],
  [/GOOGLE_ACCOUNT_MIGRATION_POSTCONDITION_CALENDAR_OPERATIONS/, "GOOGLE_MIGRATION_OPERATIONS_INVALID"],
] as const);

function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

export function startupFailureSafeCode(error: unknown): string {
  for (const candidate of errorChain(error)) {
    for (const [pattern, safeCode] of SAFE_CAUSE_CODES) {
      if (pattern.test(candidate.message)) return safeCode;
    }
  }
  if (error instanceof ConvexSupervisorError) return error.code;
  return "DESKTOP_STARTUP_FAILED";
}

export async function recordStartupFailure(
  logsDirectory: string,
  error: unknown,
  fallbackStage: DesktopStartupStage,
): Promise<void> {
  await mkdir(logsDirectory, { recursive: true, mode: 0o700 });
  const diagnostic = redactDiagnostic({
    component: "desktop",
    fromState:
      error instanceof ConvexSupervisorError && error.startupStage
        ? error.startupStage
        : safeDesktopStartupStage(fallbackStage),
    toState: "startup-failed",
    safeCode: startupFailureSafeCode(error),
  });
  await appendFile(
    join(logsDirectory, STARTUP_FAILURE_LOG),
    `${JSON.stringify(diagnostic)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
