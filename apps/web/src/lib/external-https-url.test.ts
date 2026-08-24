// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";

import { safeExternalHttpsUrl } from "./external-https-url";

describe("safeExternalHttpsUrl", () => {
  const rendererOrigin = "qali-app://renderer";
  const rejectedCandidates: readonly unknown[] = [
    undefined,
    "not a url",
    "qali://event/1",
    "file:///tmp/invite",
    "http://meet.google.com/abc",
    "https://user:pass@example.com/call",
    "https://localhost/call",
    "https://calendar.local/call",
    "https://calendar.internal/call",
    "https://127.0.0.1/call",
    "https://10.0.0.1/call",
    "https://172.16.1.1/call",
    "https://192.168.1.1/call",
    "https://[::1]/call",
    "qali-app://renderer/event/1",
    `https://example.com/${"x".repeat(2_049)}`,
  ];

  test("accepts bounded public HTTPS meeting links", () => {
    expect(
      safeExternalHttpsUrl(
        "https://meet.google.com/abc-defg-hij",
        rendererOrigin,
      )?.href,
    ).toBe("https://meet.google.com/abc-defg-hij");
  });

  test.each(rejectedCandidates)(
    "rejects non-shareable URL %p",
    (candidate: unknown) => {
      expect(safeExternalHttpsUrl(candidate, rendererOrigin)).toBeNull();
    },
  );

  test("rejects the renderer origin even when it is HTTPS", () => {
    expect(
      safeExternalHttpsUrl(
        "https://app.myqali.com/private/event/1",
        "https://app.myqali.com",
      ),
    ).toBeNull();
  });
});
