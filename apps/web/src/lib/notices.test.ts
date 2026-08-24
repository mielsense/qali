// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { toast } from "@qali/ui/lib/toast";

import {
  googleAccountFailureReason,
  noticePresentation,
  type QaliNotice,
} from "./notices";

const notices: QaliNotice[] = [
  { kind: "account-action-failed", action: "add" },
  { kind: "account-action-failed", action: "reconnect" },
  { kind: "account-action-failed", action: "disconnect" },
  { kind: "account-action-failed", action: "sync" },
  { kind: "account-action-failed", action: "sign-out" },
  { kind: "account-action-failed", action: "clear-legacy" },
  { kind: "google-account-limit" },
  { kind: "google-account-add-failed", reason: "oauth-configuration" },
  { kind: "google-account-add-failed", reason: "browser" },
  { kind: "google-account-add-failed", reason: "callback" },
  { kind: "google-account-add-failed", reason: "network" },
  { kind: "google-account-add-failed", reason: "credentials" },
  { kind: "google-account-add-failed", reason: "unknown" },
  { kind: "sign-in-failed" },
  { kind: "event-action-failed", action: "create" },
  { kind: "event-action-failed", action: "save" },
  { kind: "event-action-failed", action: "remove" },
  { kind: "event-action-failed", action: "reschedule" },
  { kind: "event-action-failed", action: "reply" },
  { kind: "link-copied", target: "event" },
  { kind: "link-copied", target: "video" },
  { kind: "copy-failed", target: "event" },
  { kind: "copy-failed", target: "video" },
  { kind: "calendar-sync-failed", reason: "desktop-required" },
  { kind: "calendar-sync-failed", reason: "connection" },
  { kind: "assistant-limit-reached" },
  { kind: "assistant-reply-failed" },
  { kind: "assistant-sign-in-failed" },
  { kind: "assistant-proposal-failed", decision: "confirm" },
  { kind: "assistant-proposal-failed", decision: "discard" },
];

const forbiddenNoticeCopy =
  /\bIPC\b|\bConvex\b|Error invoking|(?:https?|file):\/\/|(?:^|\s)\/\S+|[A-Za-z]:\\|\bat\s+\S+\s*\([^)]*:\d+:\d+\)|\b(?:stderr|stdout)\b|Unauthorized desktop|ASSISTANT_|GOOGLE_/i;

const callerPaths = [
  "../routes/_auth/login.tsx",
  "../components/calendar/event-create.tsx",
  "../components/calendar/event-edit.tsx",
  "../components/calendar/event-detail.tsx",
  "../components/calendar/use-event-drag.ts",
  "../components/workspace/account-panel.tsx",
  "../routes/_workspace/settings/calendars-google.tsx",
  "../components/workspace/assistant-panel.tsx",
  "../components/workspace/assistant-proposal-card.tsx",
] as const;

describe("Qali notices", () => {
  test("retains the deprecated UI toast compatibility boundary", () => {
    expect(typeof toast.success).toBe("function");
    expect(typeof toast.error).toBe("function");
    expect(typeof toast.warning).toBe("function");
    expect(typeof toast.info).toBe("function");
    expect(typeof toast.dismiss).toBe("function");
    expect(typeof toast.clear).toBe("function");
  });

  test("maps every closed notice variant to safe bounded presentation", () => {
    for (const notice of notices) {
      const presentation = noticePresentation(notice);
      const copy = `${presentation.title}\n${presentation.description}`;

      expect(["success", "info", "error"]).toContain(presentation.severity);
      expect(presentation.title.length).toBeGreaterThan(0);
      expect(presentation.description.length).toBeGreaterThan(0);
      expect(presentation.duration).toBeGreaterThan(0);
      expect(copy).not.toMatch(forbiddenNoticeCopy);
    }
  });

  test("keeps recovery copy specific and actionable", () => {
    expect(
      noticePresentation({
        kind: "account-action-failed",
        action: "clear-legacy",
      }),
    ).toEqual({
      severity: "error",
      title: "Old Google authorization not cleared",
      description: "Your local calendar data remains. Try again.",
      duration: 7_000,
    });
    expect(
      noticePresentation({ kind: "event-action-failed", action: "save" }),
    ).toEqual({
      severity: "error",
      title: "Event not saved",
      description: "Check your connection and try again.",
      duration: 7_000,
    });
  });

  test("maps only bounded Google OAuth codes to actionable reasons", () => {
    expect(
      googleAccountFailureReason(
        new Error(
          "Error invoking remote method: GOOGLE_OAUTH_BROWSER_OPEN_FAILED",
        ),
      ),
    ).toBe("browser");
    expect(
      googleAccountFailureReason(new Error("OAUTH_CALLBACK_LISTEN_FAILED")),
    ).toBe("callback");
    expect(
      googleAccountFailureReason(
        new Error("GOOGLE_OAUTH_REQUIRED_SCOPE_MISSING"),
      ),
    ).toBe("oauth-configuration");
    expect(
      googleAccountFailureReason(
        new Error("GOOGLE_OAUTH_PROVIDER_INVALID_CLIENT"),
      ),
    ).toBe("oauth-client");
    expect(
      googleAccountFailureReason(
        new Error("GOOGLE_OAUTH_PROVIDER_ACCESS_DENIED"),
      ),
    ).toBe("oauth-access");
    expect(
      googleAccountFailureReason(
        new Error("GOOGLE_OAUTH_PROVIDER_INVALID_SCOPE"),
      ),
    ).toBe("oauth-scope");
    expect(
      googleAccountFailureReason(
        new Error("GOOGLE_OAUTH_PROVIDER_INVALID_GRANT"),
      ),
    ).toBe("oauth-grant");
    expect(
      googleAccountFailureReason(new Error("GOOGLE_OAUTH_NETWORK_ERROR")),
    ).toBe("network");
    expect(
      googleAccountFailureReason(
        new Error("GOOGLE_OAUTH_CREDENTIALS_UNAVAILABLE"),
      ),
    ).toBe("credentials");
    expect(
      googleAccountFailureReason(new Error("/Users/honey/private secret")),
    ).toBe("unknown");
  });

  test("gives provider-specific Google remediation without provider payloads", () => {
    expect(
      noticePresentation({
        kind: "google-account-add-failed",
        reason: "oauth-client",
      }),
    ).toMatchObject({
      title: "Google rejected Qali's OAuth client",
      description:
        "Confirm this client is a Desktop app in the correct Google Cloud project.",
    });
    expect(
      noticePresentation({
        kind: "google-account-add-failed",
        reason: "oauth-access",
      }),
    ).toMatchObject({
      title: "This Google account is not allowed yet",
      description:
        "Add it as an OAuth test user, or publish Qali's consent screen.",
    });
  });

  test("removes direct toast and Sileo calls from every scoped product caller", async () => {
    for (const path of callerPaths) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");

      expect(source).not.toMatch(
        /\btoast\.(?:success|error|warning|info)\s*\(/,
      );
      expect(source).not.toContain("@qali/ui/lib/toast");
      expect(source).not.toMatch(/from\s+["']sileo["']/);
      expect(source).not.toMatch(/\bsileo\./);
      expect(source).toContain("@/lib/notices");
    }
  });

  test("keeps the Sileo product-call import inside the UI wrapper", async () => {
    const adapter = await readFile(
      new URL("./notices.ts", import.meta.url),
      "utf8",
    );
    const wrapper = await readFile(
      new URL("../../../../packages/ui/src/lib/toast.ts", import.meta.url),
      "utf8",
    );

    expect(adapter).not.toMatch(/from\s+["']sileo["']/);
    expect(adapter).not.toMatch(/\bsileo\./);
    expect(adapter).toContain("@qali/ui/lib/toast");
    expect(wrapper).toMatch(/import\s*{\s*sileo[^}]*}\s*from\s*["']sileo["']/s);
  });
});
