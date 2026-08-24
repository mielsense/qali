import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReleaseInputEntry = Readonly<{
  bytes: number;
  mode: number;
  path: string;
  sha256: string;
}>;

export type ReleaseInputAllowlist = Readonly<{
  entries: readonly ReleaseInputEntry[];
  formatVersion: 1;
}>;

export type ReleaseSourceProof = Readonly<{
  patchSha256: string;
  revision: string;
}>;

const TRACKED_ROOTS = [
  "apps/desktop/resources",
  "apps/desktop/src",
  "apps/web/src",
  "apps/web/public",
  "packages/config",
  "packages/desktop-contracts",
  "packages/domain",
  "packages/ui",
  "scripts/desktop",
] as const;

const EXACT_TRACKED_FILES = [
  "apps/desktop/electron-builder.yml",
  "apps/desktop/electron.vite.config.ts",
  "apps/desktop/package.json",
  "apps/desktop/packaged-output-policy.json",
  "apps/web/index.desktop.html",
  "apps/web/package.json",
  "bun.lock",
  "package.json",
  "packages/backend/package.json",
] as const;

const DECLARED_RESOURCE_ROOTS = [
  "node_modules/.bun/@esbuild+darwin-arm64@0.27.0/node_modules/@esbuild/darwin-arm64",
  "apps/desktop/node_modules/convex",
  "apps/desktop/node_modules/esbuild",
  "apps/desktop/node_modules/prettier",
  "apps/desktop/node_modules/ws",
  "apps/desktop/node_modules/zod",
] as const;

const DECLARED_TOOLCHAIN_ROOTS = [
  "apps/desktop/node_modules/electron",
  "apps/desktop/node_modules/electron-builder",
  "apps/desktop/node_modules/electron-vite",
  "apps/desktop/node_modules/vite",
  "node_modules/@electron/asar",
  "node_modules/.bun/esbuild@0.25.12/node_modules/esbuild",
  "node_modules/.bun/@esbuild+darwin-arm64@0.25.12/node_modules/@esbuild/darwin-arm64",
] as const;

export function declaredToolchainRoots(): readonly string[] {
  return DECLARED_TOOLCHAIN_ROOTS;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertReleaseSourceState(
  revision: string,
  status: string,
  patch: string,
): ReleaseSourceProof {
  const normalizedRevision = revision.trim();
  if (!/^[a-f0-9]{40}$/.test(normalizedRevision)) {
    throw new Error("RELEASE_SOURCE_REVISION_INVALID");
  }
  if (status.length !== 0 || patch.length !== 0) {
    throw new Error("RELEASE_SOURCE_NOT_CLEAN");
  }
  return {
    patchSha256: sha256(Buffer.from(patch)),
    revision: normalizedRevision,
  };
}

/**
 * Local packages are allowed to exercise an uncommitted tree, but they still
 * carry a deterministic provenance proof. Production packaging never calls
 * this function: it continues to require assertReleaseSourceState's clean
 * status and empty patch.
 */
export function assertLocalDevelopmentSourceState(
  revision: string,
  status: string,
  patch: string,
): ReleaseSourceProof {
  const normalizedRevision = revision.trim();
  if (!/^[a-f0-9]{40}$/.test(normalizedRevision)) {
    throw new Error("RELEASE_SOURCE_REVISION_INVALID");
  }
  return {
    patchSha256: sha256(Buffer.from(`${status}\0${patch}`)),
    revision: normalizedRevision,
  };
}

const RELEASE_SOURCE_PATHS = [
  ".",
  ":(exclude).agents/**",
  ":(exclude).claude/skills/**",
  ":(exclude).superpowers/**/progress.md",
  ":(exclude)dist/**",
] as const;

async function collectReleaseSourceMaterial(repositoryRoot: string): Promise<{
  patch: string;
  revision: string;
  status: string;
}> {
  const gitExecutable = await resolveGitExecutable(repositoryRoot);
  const git = async (...args: string[]): Promise<string> =>
    (
      await execFileAsync(gitExecutable, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout;
  const [revision, status, patch] = await Promise.all([
    git("rev-parse", "HEAD"),
    git(
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...RELEASE_SOURCE_PATHS,
    ),
    git("diff", "--binary", "HEAD", "--", ...RELEASE_SOURCE_PATHS),
  ]);
  return { patch, revision, status };
}

async function resolveGitExecutable(repositoryRoot: string): Promise<string> {
  const candidates = ["/usr/bin/git", "/opt/homebrew/bin/git"] as const;
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function collectReleaseSourceState(
  repositoryRoot: string,
): Promise<ReleaseSourceProof> {
  const { patch, revision, status } =
    await collectReleaseSourceMaterial(repositoryRoot);
  return assertReleaseSourceState(revision, status, patch);
}

export async function collectLocalDevelopmentSourceState(
  repositoryRoot: string,
): Promise<ReleaseSourceProof> {
  const { patch, revision, status } =
    await collectReleaseSourceMaterial(repositoryRoot);
  return assertLocalDevelopmentSourceState(revision, status, patch);
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        if (entry.name === "node_modules") continue;
        throw new Error(`RELEASE_INPUT_SYMLINK:${path}`);
      }
      if (metadata.isDirectory()) {
        if ([".cache", ".turbo", "dist", "node_modules"].includes(entry.name))
          continue;
        await visit(path);
      } else if (metadata.isFile()) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

async function proof(
  repositoryRoot: string,
  logicalPath: string,
): Promise<ReleaseInputEntry> {
  const logicalAbsolute = resolve(repositoryRoot, logicalPath);
  const logicalMetadata = await lstat(logicalAbsolute);
  if (logicalMetadata.isSymbolicLink()) {
    throw new Error(`RELEASE_INPUT_SYMLINK:${logicalPath}`);
  }
  const physicalPath = await realpath(logicalAbsolute);
  const metadata = await lstat(physicalPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`RELEASE_INPUT_NOT_FILE:${logicalPath}`);
  }
  const bytes = await readFile(physicalPath);
  return {
    bytes: bytes.byteLength,
    mode: metadata.mode & 0o777,
    path: logicalPath,
    sha256: sha256(bytes),
  };
}

async function allFilesUnder(
  repositoryRoot: string,
  logicalRoot: string,
): Promise<string[]> {
  const physicalRoot = await realpath(resolve(repositoryRoot, logicalRoot));
  return (await walkFiles(physicalRoot)).map(
    (path) =>
      `${logicalRoot}/${relative(physicalRoot, path).split(sep).join("/")}`,
  );
}

function backendCopied(path: string): boolean {
  if (path === "packages/backend/package.json") return true;
  if (!path.startsWith("packages/backend/convex/")) return false;
  const relativePath = path.slice("packages/backend/convex/".length);
  return (
    !/\.(?:test|itest)\.ts$/.test(relativePath) &&
    !/(?:^|\/)README\.md$/.test(relativePath) &&
    !relativePath.startsWith("_generated/ai/")
  );
}

export function isDeclaredTrackedReleasePath(path: string): boolean {
  return (
    EXACT_TRACKED_FILES.includes(
      path as (typeof EXACT_TRACKED_FILES)[number],
    ) ||
    TRACKED_ROOTS.some((root) => path.startsWith(`${root}/`)) ||
    backendCopied(path)
  );
}

export async function collectReleaseInputEntries(
  repositoryRoot: string,
): Promise<ReleaseInputEntry[]> {
  const logicalPaths = new Set<string>(EXACT_TRACKED_FILES);
  for (const root of TRACKED_ROOTS) {
    for (const path of await allFilesUnder(repositoryRoot, root))
      logicalPaths.add(path);
  }
  for (const path of await allFilesUnder(
    repositoryRoot,
    "packages/backend/convex",
  )) {
    if (backendCopied(path)) logicalPaths.add(path);
  }
  for (const root of DECLARED_RESOURCE_ROOTS) {
    for (const path of await allFilesUnder(repositoryRoot, root))
      logicalPaths.add(path);
  }
  for (const root of DECLARED_TOOLCHAIN_ROOTS) {
    for (const path of await allFilesUnder(repositoryRoot, root))
      logicalPaths.add(path);
  }
  return await Promise.all(
    [...logicalPaths].sort().map((path) => proof(repositoryRoot, path)),
  );
}

export function compareReleaseInputEntries(
  expected: readonly ReleaseInputEntry[],
  actual: readonly ReleaseInputEntry[],
): string[] {
  const issues: string[] = [];
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  if (
    expectedByPath.size !== expected.length ||
    actualByPath.size !== actual.length
  ) {
    return ["RELEASE_INPUT_DUPLICATE"];
  }
  for (const entry of expected) {
    const candidate = actualByPath.get(entry.path);
    if (!candidate) issues.push(`RELEASE_INPUT_MISSING:${entry.path}`);
    else if (
      candidate.bytes !== entry.bytes ||
      candidate.mode !== entry.mode ||
      candidate.sha256 !== entry.sha256
    )
      issues.push(`RELEASE_INPUT_CHANGED:${entry.path}`);
  }
  for (const entry of actual) {
    if (!expectedByPath.has(entry.path))
      issues.push(`RELEASE_INPUT_UNEXPECTED:${entry.path}`);
  }
  return issues;
}

export function assertSameReleaseInputPaths(
  expected: readonly ReleaseInputEntry[],
  actual: readonly ReleaseInputEntry[],
): void {
  const expectedPaths = expected.map(({ path }) => path).sort();
  const actualPaths = actual.map(({ path }) => path).sort();
  const unexpected = actualPaths.find((path) => !expectedPaths.includes(path));
  const missing = expectedPaths.find((path) => !actualPaths.includes(path));
  if (
    unexpected ||
    missing ||
    new Set(expectedPaths).size !== expectedPaths.length ||
    new Set(actualPaths).size !== actualPaths.length
  ) {
    throw new Error(
      `RELEASE_INPUT_PATH_SET_CHANGED:${unexpected ?? missing ?? "duplicate"}`,
    );
  }
}

export async function verifyReleaseInputAllowlist(
  repositoryRoot: string,
): Promise<ReleaseInputAllowlist> {
  const path = resolve(
    repositoryRoot,
    "apps/desktop/release-input-allowlist.json",
  );
  const source = await readFile(path, "utf8");
  const allowlist = JSON.parse(source) as ReleaseInputAllowlist;
  if (
    allowlist.formatVersion !== 1 ||
    !Array.isArray(allowlist.entries) ||
    allowlist.entries.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !Number.isSafeInteger(entry.mode) ||
        typeof entry.path !== "string" ||
        entry.path.length === 0 ||
        entry.path.startsWith("/") ||
        entry.path.split("/").includes("..") ||
        !/^[a-f0-9]{64}$/.test(entry.sha256),
    ) ||
    allowlist.entries.some(
      (entry, index) =>
        index > 0 && allowlist.entries[index - 1]!.path >= entry.path,
    ) ||
    source !== `${JSON.stringify(allowlist, null, 2)}\n`
  )
    throw new Error("RELEASE_INPUT_ALLOWLIST_INVALID");
  const issues = compareReleaseInputEntries(
    allowlist.entries,
    await collectReleaseInputEntries(repositoryRoot),
  );
  if (issues.length > 0) throw new Error(issues.join("\n"));
  return allowlist;
}
