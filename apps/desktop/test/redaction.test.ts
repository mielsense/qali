import { describe, expect, test } from "bun:test";

import { redactDiagnostic } from "../src/main/diagnostics/redaction";

describe("diagnostic redaction", () => {
  test("serializes only allowlisted lifecycle metadata", () => {
    const canaries = [
      "Quarterly layoff planning",
      "oauth-refresh-secret",
      "codex-auth-secret",
      "convex-admin-secret",
      "renderer.jwt.secret",
      "https://auth.example.test/callback?code=oauth-code&state=oauth-state",
      "ABCD-EFGH",
      "--config=secret",
      "/Users/honey/private/calendar.ics",
    ];
    const output = JSON.stringify(redactDiagnostic({
      component: "google-sync",
      version: "1.2.3",
      fromState: "pending",
      toState: "idle",
      durationMs: 42.8,
      count: 7,
      safeCode: "NETWORK_UNAVAILABLE",
      operationId: `op_${"a".repeat(32)}`,
      architecture: "arm64",
      title: canaries[0],
      refreshToken: canaries[1],
      codexAuth: canaries[2],
      adminKey: canaries[3],
      jwt: canaries[4],
      url: canaries[5],
      deviceCode: canaries[6],
      argv: [canaries[7]],
      homePath: canaries[8],
      nested: { prompt: canaries.join("|") },
    }));

    for (const canary of canaries) expect(output).not.toContain(canary);
    expect(JSON.parse(output)).toEqual({
      component: "google-sync",
      version: "1.2.3",
      fromState: "pending",
      toState: "idle",
      durationMs: 43,
      count: 7,
      safeCode: "NETWORK_UNAVAILABLE",
      operationId: `op_${"a".repeat(32)}`,
      architecture: "arm64",
    });
  });

  test("drops malformed would-be metadata instead of echoing it", () => {
    const secret = "do-not-serialize-this";
    expect(redactDiagnostic({
      component: secret,
      version: secret,
      safeCode: secret,
      operationId: secret,
      durationMs: -1,
      count: Number.MAX_SAFE_INTEGER + 1,
      architecture: "x64",
    })).toEqual({});
  });
});
