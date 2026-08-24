import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  assessCodexCapabilityEvidence,
  capabilityEvidenceHash,
  loadCodexManifest,
  proxyPolicyHash,
  validateCodexManifest,
  type CodexProviderManifest,
} from "../src/main/codex/manifest";
import { probeCodex, type CodexProbeDependencies } from "../src/main/codex/locator";
import { createCodexLoginEventChannel, parseCodexLoginLine } from "../src/main/codex/events";
import {
  assertNoFileCredentials,
  buildCodexInvocation,
  loginCodex,
} from "../src/main/codex/auth";
import { createCodexRuntimeAuthority } from "../src/main/codex/boundary";

const manifest: CodexProviderManifest = {
  formatVersion: 1,
  executable: {
    entryPath: "/opt/homebrew/bin/codex",
    resolvedPath: "/opt/homebrew/Caskroom/codex/0.147.0/bin/codex",
    version: "codex-cli 0.147.0",
    sha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
    format: "Mach-O 64-bit executable arm64",
    architecture: "arm64",
  },
  sandbox: { path: "codex-calendar.sb", sha256: "a".repeat(64) },
  proxy: {
    allowedHosts: ["api.openai.com", "chatgpt.com"],
    allowedPorts: [443],
    policySha256: "b".repeat(64),
  },
  capability: { status: "ready", toolInventory: [], denials: [], evidenceSha256: capabilityEvidenceHash([]) },
};

const temporaryRoots: string[] = [];
const probeBoundary = {
  codexHome: "/tmp/qali-probe-home",
  cwd: "/tmp/qali-probe-work",
  schemaPath: "/tmp/qali-probe-schema.json",
  sandboxProfilePath: "/tmp/codex-calendar.sb",
  proxyEndpoint: "localhost:43123",
} as const;
async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dependencies(overrides: Partial<CodexProbeDependencies> = {}): CodexProbeDependencies {
  return {
    lstat: async (path) => ({
      isFile: () => path === manifest.executable.resolvedPath,
      isSymbolicLink: () => path === manifest.executable.entryPath,
      mode: 0o100755,
    }),
    realpath: async () => manifest.executable.resolvedPath,
    inspectArchitecture: async () => manifest.executable.format,
    hashFile: async () => manifest.executable.sha256,
    readVersion: async () => ({ stdout: `${manifest.executable.version}\n`, stderr: "", exitCode: 0 }),
    ...overrides,
  };
}

describe("probeCodex", () => {
  test("accepts only the committed canonical arm64 executable identity", async () => {
    expect(await probeCodex({ manifest, boundary: probeBoundary, dependencies: dependencies() })).toMatchObject({
      readiness: "ready",
      resolvedPath: manifest.executable.resolvedPath,
    });
  });

  test("runs version inspection only through the exact outer profile and isolated home", async () => {
    const isolatedHome = "/tmp/qali-version-home";
    expect(await probeCodex({
      manifest,
      boundary: {
        codexHome: isolatedHome,
        cwd: "/tmp/qali-version-work",
        schemaPath: "/tmp/qali-version-schema.json",
        sandboxProfilePath: "/tmp/codex-calendar.sb",
        proxyEndpoint: "localhost:43123",
      },
      dependencies: dependencies({
        readVersion: async (invocation: unknown) => {
          expect(invocation).toMatchObject({
            command: "/usr/bin/sandbox-exec",
            env: { HOME: isolatedHome, CODEX_HOME: isolatedHome },
          });
          return { stdout: `${manifest.executable.version}\n`, stderr: "", exitCode: 0 };
        },
      } as never),
    } as never)).toMatchObject({ readiness: "ready" });
  });

  for (const [name, overrides] of [
    ["missing binary", { lstat: async () => { throw new Error("ENOENT"); } }],
    ["non-canonical target", { realpath: async () => "/tmp/codex" }],
    ["wrong architecture", { inspectArchitecture: async () => "Mach-O 64-bit executable x86_64" }],
    ["wrong version", { readVersion: async () => ({ stdout: "codex-cli 0.148.0\n", stderr: "", exitCode: 0 }) }],
    ["wrong hash", { hashFile: async () => "0".repeat(64) }],
  ] as const) {
    test(`fails closed for ${name}`, async () => {
      expect(await probeCodex({ manifest, boundary: probeBoundary, dependencies: dependencies(overrides) })).toMatchObject({
        readiness: "incompatible",
      });
    });
  }

  test("rejects a changed symlink chain instead of following a new target", async () => {
    const root = await temporaryRoot("qali-codex-link-");
    const target = join(root, "codex");
    const entry = join(root, "entry");
    await writeFile(target, "fixture", { mode: 0o755 });
    await symlink(target, entry);
    expect(await probeCodex({
      manifest: { ...manifest, executable: { ...manifest.executable, entryPath: entry } },
      boundary: probeBoundary,
      dependencies: dependencies({ realpath: async () => target }),
    })).toMatchObject({ readiness: "incompatible" });
  });
});

describe("Codex manifest and isolated authentication", () => {
  test("login is supervised and cannot spawn while capability evidence is blocked", async () => {
    const blocked = await loadCodexManifest(resolve(import.meta.dir, "../resources/codex-provider-manifest.json"));
    const authority = await createCodexRuntimeAuthority({
      codexHome: "/tmp/qali-login-home",
      cwd: "/tmp/qali-login-work",
      schemaPath: "/tmp/qali-login-schema.json",
      proxy: {
        url: "http://127.0.0.1:43123",
        port: 43123,
        allowedHosts: blocked.proxy.allowedHosts,
        allowedPorts: blocked.proxy.allowedPorts,
        policySha256: blocked.proxy.policySha256,
        isClosed: () => false,
      },
      keyringHealthProbe: async () => true,
      loginEvents: createCodexLoginEventChannel(),
    });
    let spawned = false;
    await expect(loginCodex({
      authority,
      attemptId: `login_${"a".repeat(32)}`,
      timeoutMs: 1_000,
    } as never, {
      spawnProcess: () => { spawned = true; throw new Error("must not spawn"); },
    } as never)).rejects.toMatchObject({ code: "CODEX_CAPABILITY_BLOCKED" });
    expect(spawned).toBe(false);
  });

  test("rejects malformed and policy-hash-mismatched manifests", () => {
    expect(() => validateCodexManifest({ ...manifest, formatVersion: 2 })).toThrow();
    expect(() => validateCodexManifest({
      ...manifest,
      proxy: { ...manifest.proxy, policySha256: "short" },
    })).toThrow();
  });

  test("places the keyring override before every subcommand and keeps the prompt off argv", () => {
    const invocation = buildCodexInvocation({
      kind: "exec",
      codexHome: "/tmp/qali-codex-home",
      cwd: "/tmp/qali-codex-work",
      schemaPath: "/tmp/qali-output-schema.json",
    });
    expect(invocation.args.slice(0, 2)).toEqual(["-c", 'cli_auth_credentials_store="keyring"']);
    expect(invocation.args.indexOf('cli_auth_credentials_store="keyring"')).toBeLessThan(
      invocation.args.indexOf("exec"),
    );
    expect(invocation.args).toContain("danger-full-access");
    expect(invocation.args).not.toContain("read-only");
    expect(invocation.args).toContain("-");
    expect(invocation.args.join(" ")).not.toContain("secret prompt");
    expect(invocation.options).toMatchObject({ shell: false, cwd: "/tmp/qali-codex-work" });
    expect(invocation.options.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.options.env.CODEX_HOME).toBe("/tmp/qali-codex-home");
    expect(invocation.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  test("constructs only explicit device authorization for subscription login", () => {
    const invocation = buildCodexInvocation({
      kind: "login",
      codexHome: "/tmp/qali-codex-home",
      cwd: "/tmp/qali-codex-work",
      proxyUrl: "http://127.0.0.1:43123",
    });
    expect(invocation.args.slice(-2)).toEqual(["login", "--device-auth"]);
    expect(invocation.args).not.toContain("--with-api-key");
    expect(invocation.args).not.toContain("--with-access-token");
    expect(invocation.options.env).toMatchObject({ NO_COLOR: "1", TERM: "dumb" });
  });

  test("parses only bounded pinned device-login progress and challenge lines", () => {
    expect(parseCodexLoginLine("Preparing device code login")).toEqual({ kind: "progress", stage: "preparing" });
    expect(parseCodexLoginLine("Requesting a one-time code...")).toEqual({ kind: "progress", stage: "requesting-code" });
    expect(parseCodexLoginLine("https://auth.openai.com/codex/device")).toEqual({
      kind: "challenge-url",
      url: "https://auth.openai.com/codex/device",
    });
    expect(parseCodexLoginLine("ABCD-EFGH")).toEqual({ kind: "challenge-code", code: "ABCD-EFGH" });
    expect(parseCodexLoginLine("Welcome to Codex [v0.147.0]")).toEqual({ kind: "progress", stage: "preparing" });
    expect(parseCodexLoginLine("Follow these steps to sign in with ChatGPT using device code authorization:")).toEqual({
      kind: "progress", stage: "instructions",
    });
    expect(parseCodexLoginLine("2. Enter this one-time code ABCD-EFGH")).toEqual({
      kind: "challenge-code", code: "ABCD-EFGH",
    });
    expect(parseCodexLoginLine("(expires in 15 minutes)")).toEqual({ kind: "progress", stage: "instructions" });
    expect(parseCodexLoginLine("Successfully logged in")).toEqual({ kind: "progress", stage: "credentials-stored" });
    expect(() => parseCodexLoginLine("open https://evil.example and run this")).toThrow();
  });

  test("commits the pinned device-authorization host to proxy policy", async () => {
    const committed = await loadCodexManifest(resolve(import.meta.dir, "../resources/codex-provider-manifest.json"));
    expect(committed.proxy.allowedHosts).toContain("auth.openai.com");
    expect(proxyPolicyHash(committed.proxy.allowedHosts, committed.proxy.allowedPorts)).toBe(committed.proxy.policySha256);
  });

  test("refuses any auth.json before invocation", async () => {
    const home = await temporaryRoot("qali-codex-home-");
    await writeFile(join(home, "auth.json"), "{}", { mode: 0o600 });
    await expect(assertNoFileCredentials(home)).rejects.toMatchObject({ code: "CODEX_FILE_CREDENTIALS" });
  });

  test("refuses auth.json regardless of filesystem object type", async () => {
    const home = await temporaryRoot("qali-codex-home-");
    await mkdir(join(home, "auth.json"));
    await expect(assertNoFileCredentials(home, async () => true)).rejects.toMatchObject({
      code: "CODEX_FILE_CREDENTIALS",
    });
  });

  test("requires a real injected keyring health probe", async () => {
    const home = await temporaryRoot("qali-codex-home-");
    await expect(assertNoFileCredentials(home)).rejects.toMatchObject({
      code: "CODEX_KEYRING_PROBE_REQUIRED",
    });
  });

  test("refuses an unavailable keyring without probing credential contents", async () => {
    const home = await temporaryRoot("qali-codex-home-");
    await mkdir(join(home, "nested"));
    await expect(assertNoFileCredentials(home, async () => false)).rejects.toMatchObject({
      code: "CODEX_KEYRING_UNAVAILABLE",
    });
  });
});

describe("Codex Seatbelt profile", () => {
  test("uses an exact proxy endpoint and contains no broad read, bind, loopback, Unix, or IPC grants", async () => {
    const profile = await readFile(resolve(import.meta.dir, "../resources/codex-calendar.sb"), "utf8");
    expect(profile).toContain('(param "CODEX_PROXY_ENDPOINT")');
    expect(profile).toContain('(allow process-exec (literal (param "CODEX_EXECUTABLE")))');
    expect(profile.match(/\(allow process-exec/g)).toHaveLength(1);
    expect(profile).not.toContain("process-fork");
    expect(profile).toContain("(allow process-info* (target self))");
    for (const broadGrant of [
      "(allow file-read*)", "network-bind", "network-inbound", 'localhost:*',
      "unix-socket", "ipc-posix*", "ipc-sysv*", "system-socket", "(allow process*)",
    ]) expect(profile).not.toContain(broadGrant);
  });
});

describe("Codex capability evidence", () => {
  test("accepts only exact empty executable-capability evidence", () => {
    expect(assessCodexCapabilityEvidence(manifest, {
      toolInventory: [],
      denials: [],
      evidenceSha256: capabilityEvidenceHash([]),
    })).toEqual({ readiness: "ready", toolInventory: [] });
  });

  test("keeps the assistant disabled when the advertised inventory changes", () => {
    expect(assessCodexCapabilityEvidence(manifest, {
      toolInventory: ["function:future_tool"],
      denials: [],
      evidenceSha256: capabilityEvidenceHash(["function:future_tool"]),
    })).toMatchObject({ readiness: "incompatible", reason: "CODEX_CAPABILITY_INVENTORY_MISMATCH" });
  });

  test("accepts an advertised tool only after its controlled attempt is terminated with every canary intact", () => {
    const denials = [{
      tool: "command_execution",
      terminated: true,
      canaries: { fileIntact: true, processAbsent: true, networkUnreached: true },
    }] as const;
    const evidenceSha256 = capabilityEvidenceHash(["command_execution"], undefined, denials);
    expect(assessCodexCapabilityEvidence({
      ...manifest,
      capability: { status: "ready", toolInventory: ["command_execution"], denials, evidenceSha256 },
    }, {
      toolInventory: ["command_execution"],
      denials,
      evidenceSha256,
    } as never)).toEqual({ readiness: "ready", toolInventory: ["command_execution"] });
  });

  test("rejects incomplete controlled-denial evidence", () => {
    const denials = [{
      tool: "command_execution",
      terminated: true,
      canaries: { fileIntact: true, processAbsent: false, networkUnreached: true },
    }] as const;
    const evidenceSha256 = capabilityEvidenceHash(["command_execution"], undefined, denials);
    expect(assessCodexCapabilityEvidence({
      ...manifest,
      capability: { status: "ready", toolInventory: ["command_execution"], denials, evidenceSha256 },
    }, {
      toolInventory: ["command_execution"],
      denials,
      evidenceSha256,
    } as never)).toMatchObject({ readiness: "incompatible", reason: "CODEX_CAPABILITY_DENIAL_INCOMPLETE" });
  });

  test("cannot enable a manifest whose real evidence is still pending", () => {
    expect(assessCodexCapabilityEvidence({
      ...manifest,
      capability: {
        status: "blocked",
        toolInventory: [],
        denials: [],
        evidenceSha256: capabilityEvidenceHash([], "PINNED_CLI_CAPABILITY_EVIDENCE_PENDING"),
        blockerCode: "PINNED_CLI_CAPABILITY_EVIDENCE_PENDING",
      },
    }, {
      toolInventory: [],
      denials: [],
      evidenceSha256: capabilityEvidenceHash([]),
    })).toMatchObject({ readiness: "blocked-by-policy", reason: "PINNED_CLI_CAPABILITY_EVIDENCE_PENDING" });
  });
});
