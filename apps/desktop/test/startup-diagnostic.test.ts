import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConvexSupervisorError } from "../src/main/convex/supervisor";
import {
  recordStartupFailure,
  safeDesktopStartupStage,
  startupFailureSafeCode,
} from "../src/main/diagnostics/startup-failure";

describe("startup failure diagnostics", () => {
  test("classifies known local-service failures without serializing their message", async () => {
    const secretCanary = "oauth-token-and-private-calendar-title";
    const failure = new ConvexSupervisorError(
      "BACKEND_START_FAILED",
      "Local calendar service failed to start",
      {
        startupStage: "backing-up",
        cause: new Error(`Backup database source changed during backup: ${secretCanary}`),
      },
    );

    expect(startupFailureSafeCode(failure)).toBe("BACKUP_SOURCE_CHANGED");

    const root = await mkdtemp(join(tmpdir(), "qali-startup-diagnostic-"));
    try {
      await recordStartupFailure(root, failure, "not-created");
      const output = await readFile(join(root, "desktop-startup.log"), "utf8");
      expect(output).not.toContain(secretCanary);
      expect(JSON.parse(output)).toEqual({
        component: "desktop",
        fromState: "backing-up",
        toState: "startup-failed",
        safeCode: "BACKUP_SOURCE_CHANGED",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to the supervisor code for an unrecognized private cause", () => {
    const failure = new ConvexSupervisorError(
      "BACKEND_START_FAILED",
      "Local calendar service failed to start",
      {
        startupStage: "spawning",
        cause: new Error("private unclassified details"),
      },
    );

    expect(startupFailureSafeCode(failure)).toBe("BACKEND_START_FAILED");
  });

  test("accepts only fixed privacy-safe desktop startup stages", () => {
    expect(safeDesktopStartupStage("google-accounts")).toBe("google-accounts");
    expect(safeDesktopStartupStage("private/account@example.com")).toBe(
      "not-created",
    );
  });
});
