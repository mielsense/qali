import { describe, expect, test } from "bun:test";

import {
  resolveCodexInstallation,
  type CodexCompatibilityDependencies,
  type ResolveCodexInstallationInput,
} from "../src/main/codex/app-server-compatibility";
import type { CodexProviderManifest } from "../src/main/codex/manifest";

const executable = "/opt/homebrew/Caskroom/codex/0.147.0/bin/codex";
const binarySha256 = "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37";
const schemaSha256 = "f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2";

const manifest: CodexProviderManifest = {
  formatVersion: 1,
  executable: {
    entryPath: "/opt/homebrew/bin/codex",
    resolvedPath: executable,
    version: "codex-cli 0.147.0",
    sha256: binarySha256,
    format: "Mach-O 64-bit executable arm64",
    architecture: "arm64",
  },
  discovery: { locations: [executable] },
  appServerCompatibility: [{
    compatibilityVersion: 1,
    version: "codex-cli 0.147.0",
    sha256: binarySha256,
    format: "Mach-O 64-bit executable arm64",
    architecture: "arm64",
    generatedSchema: {
      bundlePath: "codex_app_server_protocol.v2.schemas.json",
      sha256: schemaSha256,
    },
  }],
  sandbox: { path: "codex-calendar.sb", sha256: "a".repeat(64) },
  proxy: {
    allowedHosts: ["api.openai.com", "chatgpt.com"],
    allowedPorts: [443],
    policySha256: "b".repeat(64),
  },
  capability: {
    status: "blocked",
    toolInventory: [],
    denials: [],
    evidenceSha256: "c".repeat(64),
    blockerCode: "PINNED_CLI_CAPABILITY_GATE_DENIED",
  },
};

function fixture(
  overrides: Partial<CodexCompatibilityDependencies> = {},
): ResolveCodexInstallationInput {
  return {
    manifest,
    dependencies: {
      canonicalize: async (path) => path,
      lstat: async () => ({
        dev: 1,
        ino: 2,
        size: 3,
        mtimeMs: 4,
        mode: 0o100755,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
      hashFile: async () => binarySha256,
      inspectArchitecture: async () => "Mach-O 64-bit executable arm64",
      probeVersion: async ({ executablePath }) => {
        expect(executablePath).toBe(executable);
        return { stdout: "codex-cli 0.147.0\n", stderr: "", exitCode: 0 };
      },
      probeGeneratedSchema: async ({ executablePath, bundlePath }) => {
        expect(executablePath).toBe(executable);
        expect(bundlePath).toBe("codex_app_server_protocol.v2.schemas.json");
        return schemaSha256;
      },
      ...overrides,
    },
  };
}

describe("resolveCodexInstallation", () => {
  test("supports only the exact versioned binary and generated schema lane", async () => {
    await expect(resolveCodexInstallation(fixture())).resolves.toMatchObject({
      kind: "supported",
      evidence: {
        executablePath: executable,
        version: "codex-cli 0.147.0",
        arch: "arm64",
        sha256: binarySha256,
        generatedSchemaSha256: schemaSha256,
      },
    });
  });

  test("does not perform PATH lookup or fallback after an explicit selection", async () => {
    const selectedPath = "/Applications/Codex.app/Contents/MacOS/codex";
    const canonicalized: string[] = [];
    const input = fixture({
      canonicalize: async (path) => {
        canonicalized.push(path);
        return path;
      },
      hashFile: async () => "0".repeat(64),
    });

    await expect(resolveCodexInstallation({ ...input, selectedPath })).resolves.toEqual({
      kind: "incompatible",
      reason: "hash-mismatch",
    });
    expect(canonicalized).toEqual([selectedPath]);
  });

  test("continues through approved manifest locations until one is supported", async () => {
    const incompatible = "/opt/homebrew/Caskroom/codex/0.146.0/bin/codex";
    const visited: string[] = [];
    const input = fixture({
      canonicalize: async (path) => {
        visited.push(path);
        return path;
      },
      hashFile: async (path) => path === incompatible ? "0".repeat(64) : binarySha256,
    });

    await expect(resolveCodexInstallation({
      ...input,
      manifest: {
        ...manifest,
        discovery: { locations: [incompatible, executable] },
      },
    })).resolves.toMatchObject({
      kind: "supported",
      evidence: { executablePath: executable },
    });
    expect(visited).toEqual([incompatible, executable]);
  });

  test("retains the first highest-evidence manifest failure when none succeeds", async () => {
    const inconclusive = "/opt/homebrew/Caskroom/codex/0.145.0/bin/codex";
    const firstIncompatible = "/opt/homebrew/Caskroom/codex/0.146.0/bin/codex";
    const laterIncompatible = "/opt/homebrew/Caskroom/codex/0.148.0/bin/codex";
    const input = fixture({
      hashFile: async (path) => path === laterIncompatible
        ? "0".repeat(64)
        : binarySha256,
      probeVersion: async ({ executablePath }) => {
        if (executablePath === inconclusive) throw new Error("inconclusive");
        return { stdout: "codex-cli 0.148.0\n", stderr: "", exitCode: 0 };
      },
    });

    await expect(resolveCodexInstallation({
      ...input,
      manifest: {
        ...manifest,
        discovery: {
          locations: [inconclusive, firstIncompatible, laterIncompatible],
        },
      },
    })).resolves.toEqual({
      kind: "incompatible",
      reason: "version-mismatch",
    });
  });

  test("reports missing only when the selected candidate does not exist", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect(resolveCodexInstallation(fixture({
      lstat: async () => { throw missing; },
    }))).resolves.toEqual({ kind: "missing" });
  });

  test("rejects symlinks instead of allowing target drift", async () => {
    await expect(resolveCodexInstallation(fixture({
      lstat: async () => ({
        dev: 1,
        ino: 2,
        size: 3,
        mtimeMs: 4,
        mode: 0o120755,
        isFile: () => false,
        isSymbolicLink: () => true,
      }),
    }))).resolves.toEqual({ kind: "incompatible", reason: "symlink-not-allowed" });
  });

  test("requires an arm64 Mach-O executable", async () => {
    await expect(resolveCodexInstallation(fixture({
      inspectArchitecture: async () => "Mach-O 64-bit executable x86_64",
    }))).resolves.toEqual({ kind: "incompatible", reason: "architecture-mismatch" });
  });

  test("keeps version and schema mismatches distinct", async () => {
    await expect(resolveCodexInstallation(fixture({
      probeVersion: async () => ({
        stdout: "codex-cli 0.148.0\n",
        stderr: "",
        exitCode: 0,
      }),
    }))).resolves.toEqual({ kind: "incompatible", reason: "version-mismatch" });

    await expect(resolveCodexInstallation(fixture({
      probeGeneratedSchema: async () => "0".repeat(64),
    }))).resolves.toEqual({ kind: "incompatible", reason: "schema-mismatch" });
  });

  test("requires reprobe when the executable identity changes during probes", async () => {
    let statCount = 0;
    await expect(resolveCodexInstallation(fixture({
      lstat: async () => ({
        dev: 1,
        ino: 2,
        size: 3,
        mtimeMs: ++statCount === 1 ? 4 : 5,
        mode: 0o100755,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
    }))).resolves.toEqual({ kind: "needs-reprobe" });
  });

  test("returns bounded diagnostic evidence for an inconclusive probe", async () => {
    await expect(resolveCodexInstallation(fixture({
      probeVersion: async () => { throw new Error("private path or provider output"); },
    }))).resolves.toMatchObject({
      kind: "probe-failed",
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
