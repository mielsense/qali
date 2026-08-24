import { showToast, type ToastPresentation } from "@qali/ui/lib/toast";

type AccountAction =
  "add" | "reconnect" | "disconnect" | "sync" | "sign-out" | "clear-legacy";
type EventAction = "create" | "save" | "remove" | "reschedule" | "reply";
type CopyTarget = "event" | "video";
export type GoogleAccountFailureReason =
  | "oauth-configuration"
  | "oauth-client"
  | "oauth-access"
  | "oauth-scope"
  | "oauth-grant"
  | "browser"
  | "callback"
  | "network"
  | "credentials"
  | "unknown";

export type QaliNotice =
  | { kind: "account-action-failed"; action: AccountAction }
  | { kind: "google-account-limit" }
  | { kind: "google-account-add-failed"; reason: GoogleAccountFailureReason }
  | { kind: "sign-in-failed" }
  | { kind: "event-action-failed"; action: EventAction }
  | { kind: "link-copied"; target: CopyTarget }
  | { kind: "copy-failed"; target: CopyTarget }
  | {
      kind: "calendar-sync-failed";
      reason: "desktop-required" | "connection";
    }
  | { kind: "assistant-limit-reached" }
  | { kind: "assistant-reply-failed" }
  | { kind: "assistant-sign-in-failed" }
  | {
      kind: "assistant-proposal-failed";
      decision: "confirm" | "discard";
    };

const SUCCESS_DURATION = 4_000;
const INFO_DURATION = 6_000;
const ERROR_DURATION = 7_000;

function success(title: string, description: string): ToastPresentation {
  return {
    severity: "success",
    title,
    description,
    duration: SUCCESS_DURATION,
  };
}

function info(title: string, description: string): ToastPresentation {
  return { severity: "info", title, description, duration: INFO_DURATION };
}

function error(title: string, description: string): ToastPresentation {
  return { severity: "error", title, description, duration: ERROR_DURATION };
}

/** Electron includes the trusted main-process error code inside its rejected
 * invoke message. Match only a closed set of codes and never surface arbitrary
 * exception text, paths, URLs, or provider responses to the renderer. */
export function googleAccountFailureReason(
  failure: unknown,
): GoogleAccountFailureReason {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (message.includes("GOOGLE_OAUTH_BROWSER_OPEN_FAILED")) return "browser";
  if (
    message.includes("GOOGLE_OAUTH_PROVIDER_INVALID_CLIENT") ||
    message.includes("GOOGLE_OAUTH_PROVIDER_UNAUTHORIZED_CLIENT")
  )
    return "oauth-client";
  if (message.includes("GOOGLE_OAUTH_PROVIDER_ACCESS_DENIED"))
    return "oauth-access";
  if (message.includes("GOOGLE_OAUTH_PROVIDER_INVALID_SCOPE"))
    return "oauth-scope";
  if (message.includes("GOOGLE_OAUTH_PROVIDER_INVALID_GRANT"))
    return "oauth-grant";
  if (
    message.includes("OAUTH_CALLBACK_LISTEN_FAILED") ||
    message.includes("OAUTH_CALLBACK_TIMEOUT") ||
    message.includes("OAUTH_CALLBACK_EXPIRED")
  )
    return "callback";
  if (
    message.includes("GOOGLE_OAUTH_REQUIRED_SCOPE_MISSING") ||
    message.includes("GOOGLE_OAUTH_SCOPE_NOT_ALLOWED") ||
    message.includes("GOOGLE_OAUTH_TOKEN_REQUEST_FAILED") ||
    message.includes("GOOGLE_OAUTH_INVALID_TOKEN_RESPONSE")
  )
    return "oauth-configuration";
  if (
    message.includes("GOOGLE_OAUTH_NETWORK_ERROR") ||
    message.includes("GOOGLE_OAUTH_IDENTITY_REQUEST_FAILED")
  )
    return "network";
  if (
    message.includes("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE") ||
    message.includes("GOOGLE_OAUTH_CLEANUP_REQUIRED") ||
    message.includes("GOOGLE_OAUTH_DISCONNECT_REQUIRED")
  )
    return "credentials";
  return "unknown";
}

export function noticePresentation(notice: QaliNotice): ToastPresentation {
  switch (notice.kind) {
    case "account-action-failed":
      if (notice.action === "add") {
        return error(
          "Google account not added",
          "Check your connection and try again.",
        );
      }
      if (notice.action === "reconnect") {
        return error(
          "Google account not reconnected",
          "Check your connection and try again.",
        );
      }
      if (notice.action === "disconnect") {
        return error(
          "Google not disconnected",
          "Try again. Your calendars remain connected.",
        );
      }
      if (notice.action === "sync") {
        return error(
          "Google account not synced",
          "Check your connection and try again.",
        );
      }
      if (notice.action === "clear-legacy") {
        return error(
          "Old Google authorization not cleared",
          "Your local calendar data remains. Try again.",
        );
      }
      return error("Not signed out", "Check your connection and try again.");

    case "google-account-limit":
      return info(
        "Google account limit reached",
        "Qali supports up to eight connected Google accounts.",
      );

    case "google-account-add-failed":
      if (notice.reason === "oauth-client") {
        return error(
          "Google rejected Qali's OAuth client",
          "Confirm this client is a Desktop app in the correct Google Cloud project.",
        );
      }
      if (notice.reason === "oauth-access") {
        return error(
          "This Google account is not allowed yet",
          "Add it as an OAuth test user, or publish Qali's consent screen.",
        );
      }
      if (notice.reason === "oauth-scope") {
        return error(
          "Calendar access was not approved",
          "Enable the Google Calendar API and verify Qali's consent-screen scopes.",
        );
      }
      if (notice.reason === "oauth-grant") {
        return error(
          "Google authorization expired",
          "Try again. If it repeats, remove Qali from Google account access and reconnect.",
        );
      }
      if (notice.reason === "oauth-configuration") {
        return error(
          "Google OAuth setup needs attention",
          "Verify the Desktop client, Calendar API, and consent-screen configuration.",
        );
      }
      if (notice.reason === "browser") {
        return error(
          "Browser did not open",
          "Check your default browser, then try adding the account again.",
        );
      }
      if (notice.reason === "callback") {
        return error(
          "Google could not return to Qali",
          "Check firewall or VPN settings, then try again.",
        );
      }
      if (notice.reason === "network") {
        return error(
          "Google is unreachable",
          "Check your internet connection, then try again.",
        );
      }
      if (notice.reason === "credentials") {
        return error(
          "Google authorization needs repair",
          "Clear the old authorization shown here, then add the account again.",
        );
      }
      return error(
        "Google account not added",
        "Try again. If it still fails, check Qali's OAuth test-user access.",
      );

    case "sign-in-failed":
      return error("Sign-in failed", "Check your connection and try again.");

    case "event-action-failed": {
      const title = {
        create: "Event not created",
        save: "Event not saved",
        remove: "Event not removed",
        reschedule: "Event not rescheduled",
        reply: "Reply not sent",
      }[notice.action];
      return error(title, "Check your connection and try again.");
    }

    case "link-copied":
      return success(
        notice.target === "video" ? "Video link copied" : "Event link copied",
        "The link is ready to paste.",
      );

    case "copy-failed": {
      const title = {
        event: "Event link not copied",
        video: "Video link not copied",
      }[notice.target];
      return error(title, "Check clipboard access and try again.");
    }

    case "calendar-sync-failed":
      return notice.reason === "desktop-required"
        ? error("Calendar not synced", "Open the desktop app and try again.")
        : error("Calendar not synced", "Check your connection and try again.");

    case "assistant-limit-reached":
      return error(
        "Monthly assistant limit reached",
        "Try again after your monthly limit resets.",
      );

    case "assistant-reply-failed":
      return error(
        "Assistant could not reply",
        "Your draft was kept. Try again.",
      );

    case "assistant-sign-in-failed":
      return error("Assistant not signed in", "Try signing in again.");

    case "assistant-proposal-failed":
      return notice.decision === "confirm"
        ? error("Change not applied", "Review the proposal and try again.")
        : error("Proposal not discarded", "Try discarding it again.");

  }
}

export function notify(notice: QaliNotice): string {
  return showToast(noticePresentation(notice));
}
