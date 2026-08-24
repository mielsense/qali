import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { sha256File, type CodexProviderManifest } from "./manifest";
import { codexSandboxMetadataPathArguments } from "./sandbox-metadata";

const execFileAsync = promisify(execFile);

export type CodexReadiness = "ready" | "incompatible" | "blocked-by-policy";
export type CodexProbeResult = Readonly<{
  readiness: CodexReadiness;
  reason?: string;
  resolvedPath?: string;
  version?: string;
  sha256?: string;
  format?: string;
}>;

type StatLike = { isFile(): boolean; isSymbolicLink(): boolean; mode: number };
type VersionResult = { stdout: string; stderr: string; exitCode: number };
export type CodexProbeBoundary = Readonly<{
  codexHome: string;
  cwd: string;
  schemaPath: string;
  sandboxProfilePath: string;
  proxyEndpoint: string;
}>;
export type CodexVersionInvocation = Readonly<{
  command: "/usr/bin/sandbox-exec";
  args: string[];
  cwd: string;
  env: Record<string, string>;
}>;
export type CodexProbeDependencies = Readonly<{
  lstat(path: string): Promise<StatLike>;
  realpath(path: string): Promise<string>;
  inspectArchitecture(path: string): Promise<string>;
  hashFile(path: string): Promise<string>;
  readVersion(invocation: CodexVersionInvocation): Promise<VersionResult>;
}>;

const defaultDependencies: CodexProbeDependencies = {
  lstat,
  realpath,
  hashFile: sha256File,
  async inspectArchitecture(path) {
    const { stdout } = await execFileAsync("/usr/bin/file", ["-b", path], {
      timeout: 2_000,
      maxBuffer: 4_096,
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
    });
    return stdout.trim();
  },
  async readVersion(invocation) {
    try {
      const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        timeout: 2_000,
        maxBuffer: 16_384,
        env: invocation.env,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code ?? 1 };
    }
  },
};

export async function probeCodex(input: {
  manifest: CodexProviderManifest;
  boundary: CodexProbeBoundary;
  dependencies?: CodexProbeDependencies;
}): Promise<CodexProbeResult> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const expected = input.manifest.executable;
  try {
    if (expected.entryPath !== "/opt/homebrew/bin/codex") throw new Error("unexpected entry path");
    const entry = await dependencies.lstat(expected.entryPath);
    if (!entry.isSymbolicLink()) throw new Error("entry is not the committed Homebrew symlink");
    const resolvedPath = await dependencies.realpath(expected.entryPath);
    if (resolvedPath !== expected.resolvedPath) throw new Error("canonical target changed");
    const target = await dependencies.lstat(resolvedPath);
    if (!target.isFile() || target.isSymbolicLink() || (target.mode & 0o111) === 0) {
      throw new Error("canonical target is not a regular executable");
    }
    const format = await dependencies.inspectArchitecture(resolvedPath);
    if (format !== expected.format || !format.endsWith("arm64")) throw new Error("architecture changed");
    const sha256 = await dependencies.hashFile(resolvedPath);
    if (sha256 !== expected.sha256) throw new Error("content digest changed");
    const boundary = input.boundary;
    const [codexHome, cwd] = input.dependencies
      ? [boundary.codexHome, boundary.cwd]
      : await Promise.all([
          dependencies.realpath(boundary.codexHome),
          dependencies.realpath(boundary.cwd),
        ]);
    const version = await dependencies.readVersion({
      command: "/usr/bin/sandbox-exec",
      args: [
        ...codexSandboxMetadataPathArguments([codexHome, cwd]),
        "-D", `CODEX_HOME=${codexHome}`,
        "-D", `CODEX_CWD=${cwd}`,
        "-D", `CODEX_SCHEMA=${boundary.schemaPath}`,
        "-D", `CODEX_EXECUTABLE=${resolvedPath}`,
        "-D", `CODEX_PROXY_ENDPOINT=${boundary.proxyEndpoint}`,
        "-f", boundary.sandboxProfilePath,
        resolvedPath, "--version",
      ],
      cwd,
      env: {
        CODEX_HOME: codexHome,
        HOME: codexHome,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/bin:/bin",
        TMPDIR: codexHome,
      },
    });
    if (version.exitCode !== 0 || version.stdout.trim() !== expected.version) throw new Error("version changed");
    if (input.manifest.capability.status === "blocked") {
      return { readiness: "blocked-by-policy", reason: input.manifest.capability.blockerCode, resolvedPath, version: version.stdout.trim(), sha256, format };
    }
    return { readiness: "ready", resolvedPath, version: version.stdout.trim(), sha256, format };
  } catch (error) {
    return { readiness: "incompatible", reason: error instanceof Error ? error.message : "probe failed" };
  }
}
