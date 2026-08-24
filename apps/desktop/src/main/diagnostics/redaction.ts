export type RedactedDiagnostic = Readonly<{
  component?: string;
  version?: string;
  fromState?: string;
  toState?: string;
  durationMs?: number;
  count?: number;
  safeCode?: string;
  operationId?: string;
  migrationState?: string;
  restartState?: string;
  architecture?: "arm64";
}>;

const COMPONENTS = new Set([
  "desktop",
  "ipc",
  "convex",
  "google-sync",
  "codex",
  "recovery",
  "migration",
]);
const VERSION = /^v?\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/;
const STATE = /^[a-z][a-z0-9-]{0,47}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CORRELATION_ID = /^(?:op|assistant|login|sync|migration)_[0-9a-f]{32}$/;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_COUNT = 1_000_000;

function boundedInteger(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded <= maximum ? rounded : undefined;
}

function allowedString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * Convert an arbitrary diagnostic observation into Qali's deliberately tiny
 * lifecycle schema. Content is never recursively scrubbed: it is never
 * collected in the first place, so unknown fields cannot reach a sink.
 */
export function redactDiagnostic(event: unknown): RedactedDiagnostic {
  if (!event || typeof event !== "object" || Array.isArray(event)) return Object.freeze({});
  const input = event as Record<string, unknown>;
  const output: Record<string, string | number> = {};
  const component =
    typeof input.component === "string" && COMPONENTS.has(input.component)
      ? input.component
      : undefined;
  const version = allowedString(input.version, VERSION);
  const fromState = allowedString(input.fromState, STATE);
  const toState = allowedString(input.toState, STATE);
  const safeCode = allowedString(input.safeCode, SAFE_CODE);
  const operationId = allowedString(input.operationId, CORRELATION_ID);
  const migrationState = allowedString(input.migrationState, STATE);
  const restartState = allowedString(input.restartState, STATE);
  const durationMs = boundedInteger(input.durationMs, MAX_DURATION_MS);
  const count = boundedInteger(input.count, MAX_COUNT);

  if (component !== undefined) output.component = component;
  if (version !== undefined) output.version = version;
  if (fromState !== undefined) output.fromState = fromState;
  if (toState !== undefined) output.toState = toState;
  if (durationMs !== undefined) output.durationMs = durationMs;
  if (count !== undefined) output.count = count;
  if (safeCode !== undefined) output.safeCode = safeCode;
  if (operationId !== undefined) output.operationId = operationId;
  if (migrationState !== undefined) output.migrationState = migrationState;
  if (restartState !== undefined) output.restartState = restartState;
  if (input.architecture === "arm64") output.architecture = "arm64";
  return Object.freeze(output) as RedactedDiagnostic;
}
