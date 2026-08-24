import { describe, expect, test } from "bun:test";

import {
  comparePackagedOutputPolicy,
  encodePackagedOutputPolicy,
  parsePackagedOutputPolicy,
  type PackagedOutputPolicy,
} from "../../../scripts/desktop/lib/packaged-output-policy";

const file = (path: string) => ({
  bytes: 3,
  kind: "file" as const,
  mode: 0o644,
  path,
  sha256: "a".repeat(64),
});

describe("pre-seal packaged output policy", () => {
  const policy: PackagedOutputPolicy = {
    asarEntries: [file("/main/index.js")],
    formatVersion: 1,
    resourceEntries: [file("app.asar")],
  };

  test("rejects the reviewer's generated-output injection before sealing", () => {
    const issues = comparePackagedOutputPolicy(policy, {
      asarEntries: [...policy.asarEntries, file("/untracked-generated-output.ts")],
      resourceEntries: policy.resourceEntries,
    });
    expect(issues).toContainEqual(expect.objectContaining({
      path: "/untracked-generated-output.ts",
      rule: "ASAR_INVENTORY_UNEXPECTED",
    }));
  });

  test("rejects a benign injected resource and is canonical encoded", () => {
    expect(comparePackagedOutputPolicy(policy, {
      asarEntries: policy.asarEntries,
      resourceEntries: [...policy.resourceEntries, file("untracked-generated-output.ts")],
    })).toContainEqual(expect.objectContaining({
      path: "untracked-generated-output.ts",
      rule: "RESOURCE_INVENTORY_UNEXPECTED",
    }));
    expect(encodePackagedOutputPolicy(policy)).toBe(
      `${JSON.stringify(policy, null, 2)}\n`,
    );
  });

  test("rejects non-canonical inventory ordering", () => {
    const unordered: PackagedOutputPolicy = {
      ...policy,
      asarEntries: [file("/z.js"), file("/a.js")],
    };
    expect(() => parsePackagedOutputPolicy(encodePackagedOutputPolicy(unordered))).toThrow(
      "PACKAGED_OUTPUT_POLICY_INVALID",
    );
  });
});
