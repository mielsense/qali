import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
  sha256Bytes,
  sha256File,
  type CodexAppServerCompatibilityEntry,
  type CodexProviderManifest,
} from "./manifest";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION_TIMEOUT_MS = 3_000;
const SCHEMA_TIMEOUT_MS = 10_000;
const PROBE_MAX_BUFFER = 16 * 1024;

type StatLike = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeMs: number;
  mode: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

type ProbeResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type CodexInstallationEvidence = Readonly<{
  executablePath: string;
  version: string;
  arch: "arm64";
  format: string;
  sha256: string;
  generatedSchemaSha256: string;
}>;

export type CodexInstallationResolution =
  | Readonly<{ kind: "supported"; evidence: CodexInstallationEvidence }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "needs-reprobe" }>
  | Readonly<{ kind: "incompatible"; reason: string }>
  | Readonly<{ kind: "probe-failed"; evidenceDigest: string }>;

export type CodexCompatibilityDependencies = Readonly<{
  canonicalize(path: string): Promise<string>;
  lstat(path: string): Promise<StatLike>;
  inspectArchitecture(path: string): Promise<string>;
  hashFile(path: string): Promise<string>;
  probeVersion(input: Readonly<{ executablePath: string }>): Promise<ProbeResult>;
  probeGeneratedSchema(input: Readonly<{
    executablePath: string;
    bundlePath: string;
  }>): Promise<string>;
}>;

export type ResolveCodexInstallationInput = Readonly<{
  manifest: CodexProviderManifest;
  selectedPath?: string;
  dependencies?: CodexCompatibilityDependencies;
}>;

function minimalProbeEnvironment(isolatedRoot = "/var/empty"): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: isolatedRoot,
    HOME: isolatedRoot,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: "/usr/bin:/bin",
    TMPDIR: isolatedRoot,
  };
}

const defaultDependencies: CodexCompatibilityDependencies = {
  canonicalize: realpath,
  lstat,
  hashFile: sha256File,
  async inspectArchitecture(path) {
    const { stdout } = await execFileAsync("/usr/bin/file", ["-b", path], {
      env: minimalProbeEnvironment(),
      maxBuffer: 4_096,
      shell: false,
      timeout: VERSION_TIMEOUT_MS,
    });
    return stdout.trim();
  },
  async probeVersion({ executablePath }) {
    try {
      const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
        env: minimalProbeEnvironment(),
        maxBuffer: PROBE_MAX_BUFFER,
        shell: false,
        timeout: VERSION_TIMEOUT_MS,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
  async probeGeneratedSchema({ executablePath, bundlePath }) {
    const outputRoot = await mkdtemp(join(tmpdir(), "qali-codex-schema-"));
    try {
      await execFileAsync(
        executablePath,
        ["app-server", "generate-json-schema", "--out", outputRoot],
        {
          env: minimalProbeEnvironment(outputRoot),
          maxBuffer: PROBE_MAX_BUFFER,
          shell: false,
          timeout: SCHEMA_TIMEOUT_MS,
        },
      );
      return await sha256File(join(outputRoot, bundlePath));
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  },
};

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT");
}

function sameIdentity(left: StatLike, right: StatLike): boolean {
  return String(left.dev) === String(right.dev) &&
    String(left.ino) === String(right.ino) &&
    String(left.size) === String(right.size) &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode;
}

function probeFailure(stage: string, error: unknown): CodexInstallationResolution {
  const category = error instanceof Error ? error.name : typeof error;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "unknown";
  return {
    kind: "probe-failed",
    evidenceDigest: sha256Bytes(JSON.stringify({ category, code, stage })),
  };
}

function entryForHash(
  entries: readonly CodexAppServerCompatibilityEntry[],
  sha256: string,
): CodexAppServerCompatibilityEntry | undefined {
  return entries.find((entry) => entry.sha256 === sha256);
}

function failureEvidenceRank(result: CodexInstallationResolution): number {
  switch (result.kind) {
    case "incompatible": return 3;
    case "needs-reprobe": return 2;
    case "probe-failed": return 1;
    case "missing": return 0;
    case "supported": return 4;
  }
}

async function resolveCandidate(
  candidate: string,
  entries: readonly CodexAppServerCompatibilityEntry[],
  dependencies: CodexCompatibilityDependencies,
): Promise<CodexInstallationResolution> {
  if (!isAbsolute(candidate)) {
    return { kind: "incompatible", reason: "path-not-absolute" };
  }

  let stage = "candidate-stat";
  try {
    const requestedStat = await dependencies.lstat(candidate);
    if (requestedStat.isSymbolicLink()) {
      return { kind: "incompatible", reason: "symlink-not-allowed" };
    }
    if (!requestedStat.isFile()) {
      return { kind: "incompatible", reason: "not-regular-file" };
    }
    if ((requestedStat.mode & 0o111) === 0) {
      return { kind: "incompatible", reason: "not-executable" };
    }

    stage = "canonicalize";
    const executablePath = await dependencies.canonicalize(candidate);
    if (executablePath !== candidate) {
      return { kind: "incompatible", reason: "non-canonical-path" };
    }
    const before = requestedStat;

    stage = "architecture";
    const format = await dependencies.inspectArchitecture(executablePath);
    const architectureEntries = entries.filter((entry) =>
      entry.architecture === "arm64" && entry.format === format);
    if (architectureEntries.length === 0) {
      return { kind: "incompatible", reason: "architecture-mismatch" };
    }

    stage = "binary-hash";
    const sha256 = await dependencies.hashFile(executablePath);
    const entry = entryForHash(architectureEntries, sha256);
    if (!entry) return { kind: "incompatible", reason: "hash-mismatch" };

    stage = "version";
    const versionProbe = await dependencies.probeVersion({ executablePath });
    if (versionProbe.exitCode !== 0) {
      throw Object.assign(new Error("version probe failed"), {
        code: `exit-${versionProbe.exitCode}`,
      });
    }
    const version = versionProbe.stdout.trim();
    if (version !== entry.version) {
      return { kind: "incompatible", reason: "version-mismatch" };
    }

    stage = "generated-schema";
    const generatedSchemaSha256 = await dependencies.probeGeneratedSchema({
      executablePath,
      bundlePath: entry.generatedSchema.bundlePath,
    });
    if (!SHA256.test(generatedSchemaSha256)) {
      throw new Error("invalid generated schema digest");
    }
    if (generatedSchemaSha256 !== entry.generatedSchema.sha256) {
      return { kind: "incompatible", reason: "schema-mismatch" };
    }

    stage = "identity-recheck";
    const after = await dependencies.lstat(executablePath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      (after.mode & 0o111) === 0 ||
      !sameIdentity(before, after)
    ) {
      return { kind: "needs-reprobe" };
    }

    return {
      kind: "supported",
      evidence: Object.freeze({
        executablePath,
        version,
        arch: entry.architecture,
        format,
        sha256,
        generatedSchemaSha256,
      }),
    };
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    return probeFailure(stage, error);
  }
}

/**
 * Resolves a Codex installation only from shipped locations or one explicit
 * selection. This is deliberately installation-only: it never checks login,
 * reads credentials, contacts the provider, or searches PATH.
 */
export async function resolveCodexInstallation(
  input: ResolveCodexInstallationInput,
): Promise<CodexInstallationResolution> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const candidates = input.selectedPath === undefined
    ? input.manifest.discovery.locations
    : [input.selectedPath];
  let retainedFailure: CodexInstallationResolution | undefined;

  for (const candidate of candidates) {
    const result = await resolveCandidate(
      candidate,
      input.manifest.appServerCompatibility,
      dependencies,
    );
    if (input.selectedPath !== undefined || result.kind === "supported") return result;
    if (
      retainedFailure === undefined ||
      failureEvidenceRank(result) > failureEvidenceRank(retainedFailure)
    ) {
      retainedFailure = result;
    }
  }
  return retainedFailure ?? { kind: "missing" };
}
