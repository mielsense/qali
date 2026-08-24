import type { GoogleCalendarErrorKind } from "./types";

export type GoogleCalendarErrorCode =
  | "aborted"
  | "api-not-configured"
  | "invalid-request"
  | "invalid-response"
  | "network-failure"
  | "not-found"
  | "provider-rejected"
  | "sync-token-expired"
  | "write-outcome-unknown";

export class GoogleCalendarError extends Error {
  constructor(
    readonly kind: GoogleCalendarErrorKind,
    readonly code: GoogleCalendarErrorCode,
    options: Readonly<{
      operationId?: string;
      retryAfterMs?: number;
      status?: number;
    }> = {},
  ) {
    super(safeMessage(kind, code));
    this.name = "GoogleCalendarError";
    this.operationId = options.operationId;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }

  readonly operationId?: string;
  readonly retryAfterMs?: number;
  readonly status?: number;
}

function safeMessage(
  kind: GoogleCalendarErrorKind,
  code: GoogleCalendarErrorCode,
): string {
  if (code === "sync-token-expired") return "Google sync token expired";
  if (code === "api-not-configured") {
    return "Google Calendar API is not enabled for this OAuth project";
  }
  if (code === "not-found") return "Google Calendar resource was not found";
  if (kind === "ambiguous") return "Google write outcome is unknown";
  if (kind === "network") return "Google Calendar is unreachable";
  if (kind === "rate-limit") return "Google Calendar rate limit reached";
  if (kind === "auth") return "Google Calendar authorization failed";
  if (kind === "conflict") return "Google Calendar write conflict";
  if (kind === "validation") return "Google Calendar request was rejected";
  return "Google Calendar returned an invalid response";
}

export function isGoogleSyncTokenExpired(
  error: unknown,
): error is GoogleCalendarError & { code: "sync-token-expired" } {
  return (
    error instanceof GoogleCalendarError && error.code === "sync-token-expired"
  );
}

export function googleValidationError(): GoogleCalendarError {
  return new GoogleCalendarError("validation", "invalid-request");
}
