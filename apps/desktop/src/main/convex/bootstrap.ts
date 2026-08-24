import { createHash, randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { AppIdentity } from "../identity";
import type { KeychainStore } from "../keychain/keychain";
import type { QaliPaths } from "../paths";
import {
  observeOwnedSpawn,
  registerOwnedInstanceSecret,
} from "../processes/owned-spawn-observer";
import { createColdBackup } from "./backup";
import {
  configureLocalAuthEnvironment,
  deployConvexProject,
} from "./deploy";
import {
  createRotatingLogWriter,
  reclaimVerifiedOrphanBackend,
  spawnBackend,
  type BackendSpawn,
} from "./process-driver";
import type {
  ConvexSupervisorDriver,
  ResolvedConvexRuntime,
  VersionProof,
} from "./supervisor";

type SecretStore = Pick<KeychainStore, "get" | "set">;

type ArtifactProof = { path: string; sha256: string; bytes?: number };

type ReleaseManifest = {
  target: "aarch64-apple-darwin";
  convex: {
    cli: { version: "1.42.1"; path: string; sha256: string };
    backend: {
      release: "precompiled-2026-07-25-f4a0132";
      commit: string;
      path: string;
      sha256: string;
      serverVersion: string;
    };
    keygen: { path: string; sha256: string };
  };
};

export type ConvexBootstrapOptions = Readonly<{
  identity: AppIdentity;
  paths: QaliPaths;
  resourcesRoot: string;
  backendProjectDirectory: string;
  electronExecutable: string;
  nodeModulesPath: string;
  requirePackagedResourceManifest: boolean;
  keychain: SecretStore;
}>;

export type BootstrappedConvexRuntime = ResolvedConvexRuntime & Readonly<{
  cliEntryPath: string;
  runtimeModulesRoot?: string;
  backendProjectDirectory: string;
  electronExecutable: string;
  esbuildExecutable?: string;
  nodeModulesPath: string;
  previousBuildMarker: string | null;
}>;

const CHANNEL_PORTS = Object.freeze({
  stable: { deployment: 3210, site: 3211 },
  development: { deployment: 3310, site: 3311 },
  test: { deployment: 3410, site: 3411 },
});
const BUILD_MARKER_FILE = "desktop-build-marker.json";
const KEYGEN_TIMEOUT_MS = 10_000;
const KEYGEN_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_KEYGEN_REQUEST_BYTES = 4_096;
const MAX_DEPLOYABLE_PROJECT_FILES = 10_000;
const MAX_DEPLOYABLE_PROJECT_BYTES = 64 * 1024 * 1024;
const DEPLOYABLE_PROJECT_DIRECTORIES = ["convex", "vendor"] as const;
const DEPLOYABLE_ROOT_FILES = ["package.json"] as const;
const PACKAGED_ESBUILD_PATH =
  "app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild";
const PACKAGED_RUNTIME_MODULES_PATH = "app.asar.unpacked/node_modules";

function isContainedBy(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return childRelativePath === "" || (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath));
}
async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectPackagedArtifactProof(
  path: string,
  packagedManifest: unknown,
): ArtifactProof {
  if (!isRecord(packagedManifest)) {
    throw new Error("Packaged resource manifest is unavailable");
  }
  const entries = packagedManifest.entries;
  if (packagedManifest.formatVersion !== 2 || !Array.isArray(entries)) {
    throw new Error("Packaged resource manifest is invalid");
  }
  const matches = entries.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.path === path,
  );
  const match = matches[0];
  if (
    matches.length !== 1 ||
    !match ||
    typeof match.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(match.sha256) ||
    !Number.isSafeInteger(match.bytes) ||
    (match.bytes as number) < 1
  ) {
    throw new Error("Packaged resource proof is invalid");
  }
  return {
    bytes: match.bytes as number,
    path,
    sha256: match.sha256,
  };
}

export function selectRuntimeArtifactProof(
  source: ArtifactProof,
  packagedManifest: unknown,
  requirePackagedResourceManifest: boolean,
): ArtifactProof {
  return requirePackagedResourceManifest
    ? selectPackagedArtifactProof(source.path, packagedManifest)
    : source;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectDeployableFiles(
  projectRoot: string,
  path: string,
  files: string[],
): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error("Convex deployable project cannot contain symbolic links");
  }
  if (metadata.isFile()) {
    files.push(relative(projectRoot, path).replaceAll("\\", "/"));
    if (files.length > MAX_DEPLOYABLE_PROJECT_FILES) {
      throw new Error("Convex deployable project contains too many files");
    }
    return;
  }
  if (!metadata.isDirectory()) return;
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    await collectDeployableFiles(projectRoot, join(path, entry.name), files);
  }
}

export async function computeDeployableProjectDigest(
  backendProjectDirectory: string,
): Promise<string> {
  const projectRoot = await realpath(resolve(backendProjectDirectory));
  const files: string[] = [];
  for (const file of DEPLOYABLE_ROOT_FILES) {
    const path = join(projectRoot, file);
    try {
      await collectDeployableFiles(projectRoot, path, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const directory of DEPLOYABLE_PROJECT_DIRECTORIES) {
    const path = join(projectRoot, directory);
    try {
      await collectDeployableFiles(projectRoot, path, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  files.sort(comparePaths);
  if (files.length === 0) throw new Error("Convex deployable project has no source files");

  const digest = createHash("sha256").update("qali-convex-project-v1\0");
  let totalBytes = 0;
  for (const file of files) {
    const contents = await readFile(join(projectRoot, file));
    totalBytes += contents.byteLength;
    if (totalBytes > MAX_DEPLOYABLE_PROJECT_BYTES) {
      throw new Error("Convex deployable project exceeds its digest size limit");
    }
    digest.update(`${Buffer.byteLength(file, "utf8")}:${file}:${contents.byteLength}:`);
    digest.update(contents);
  }
  return digest.digest("hex");
}

async function verifyResource(root: string, proof: ArtifactProof): Promise<string> {
  const candidate = resolve(root, proof.path);
  if (!isContainedBy(root, candidate)) throw new Error("Convex resource escaped its immutable root");
  const metadata = await lstat(candidate);
  const resource = await realpath(candidate);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (proof.bytes !== undefined && metadata.size !== proof.bytes) ||
    await sha256File(resource) !== proof.sha256
  ) {
    throw new Error("Bundled Convex resource failed release-manifest verification");
  }
  return resource;
}

async function verifyPackagedDirectory(root: string, path: string): Promise<string> {
  const candidate = resolve(root, path);
  if (!isContainedBy(root, candidate)) {
    throw new Error("Packaged Convex runtime escaped its immutable root");
  }
  const metadata = await lstat(candidate);
  const directory = await realpath(candidate);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !isContainedBy(root, directory)
  ) {
    throw new Error("Packaged Convex runtime module is invalid");
  }
  return directory;
}

async function readManifest(resourcesRoot: string): Promise<ReleaseManifest> {
  const raw = await readFile(join(resourcesRoot, "release-manifest.json"), "utf8");
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("Convex release manifest is too large");
  const manifest = JSON.parse(raw) as ReleaseManifest;
  if (
    manifest.target !== "aarch64-apple-darwin" ||
    manifest.convex.cli.version !== "1.42.1" ||
    manifest.convex.backend.release !== "precompiled-2026-07-25-f4a0132"
  ) throw new Error("Unsupported Convex release manifest");
  return manifest;
}

async function getOrCreateSecret(
  keychain: SecretStore,
  account: "convex-instance-root-secret",
): Promise<string> {
  const existing = await keychain.get(account);
  if (existing !== null) {
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error("Stored Convex instance secret is invalid");
    return existing;
  }
  const generated = randomBytes(32).toString("hex");
  await keychain.set(account, generated);
  return generated;
}

export async function deriveAdminCredential(
  keychain: SecretStore,
  helperPath: string,
  instanceName: string,
  instanceSecret: string,
  spawnProcess: BackendSpawn = nodeSpawn,
): Promise<string> {
  const existing = await keychain.get("convex-admin-credential");
  const credentialPattern = new RegExp(`^${instanceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|01[a-f0-9]{72}$`);
  if (existing !== null) {
    if (!credentialPattern.test(existing)) throw new Error("Stored Convex admin credential is invalid");
    return existing;
  }
  const request = Buffer.from(JSON.stringify({ instanceName, instanceSecret }), "utf8");
  if (request.byteLength > MAX_KEYGEN_REQUEST_BYTES) {
    request.fill(0);
    throw new Error("Convex key generator request is too large");
  }
  let stdout = Buffer.alloc(0);
  let child: ChildProcessWithoutNullStreams | null = null;
  let exitTimeout: ReturnType<typeof setTimeout> | null = null;
  let processSettled = false;
  let stdinSettled = false;
  let processClosed: Promise<void> = Promise.resolve();
  let stdinCompletion: Promise<void> = Promise.resolve();
  try {
    observeOwnedSpawn(
      "convex-keygen",
      helperPath,
      [],
      { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    );
    const spawnedChild = spawnProcess(helperPath, [], {
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
    child = spawnedChild;
    spawnedChild.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > 4_096) spawnedChild.kill("SIGKILL");
    });
    spawnedChild.stderr.resume();

    let resolveProcessClosed!: () => void;
    processClosed = new Promise<void>((resolvePromise) => {
      resolveProcessClosed = resolvePromise;
    });
    const exit = new Promise<number | null>((resolvePromise, rejectPromise) => {
      exitTimeout = setTimeout(() => {
        spawnedChild.kill("SIGKILL");
        rejectPromise(new Error("Convex key generator timed out"));
      }, KEYGEN_TIMEOUT_MS);
      spawnedChild.once("error", () => {
        processSettled = true;
        if (exitTimeout) clearTimeout(exitTimeout);
        resolveProcessClosed();
        rejectPromise(new Error("Convex key generator could not start"));
      });
      spawnedChild.once("exit", (code) => {
        processSettled = true;
        if (exitTimeout) clearTimeout(exitTimeout);
        resolveProcessClosed();
        resolvePromise(code);
      });
    });

    stdinCompletion = new Promise<void>((resolvePromise, rejectPromise) => {
      const finish = (error?: Error) => {
        if (stdinSettled) return;
        stdinSettled = true;
        spawnedChild.stdin.off("error", onError);
        spawnedChild.stdin.off("close", onClose);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const onError = () => finish(new Error("Convex key generator stdin failed"));
      const onClose = () => finish(new Error("Convex key generator stdin closed early"));
      spawnedChild.stdin.once("error", onError);
      spawnedChild.stdin.once("close", onClose);
      spawnedChild.stdin.end(request, (error?: Error | null) => finish(error ?? undefined));
    });

    const [exitCode] = await Promise.all([exit, stdinCompletion]);
    const credential = stdout.toString("utf8").trim();
    if (exitCode !== 0 || !credentialPattern.test(credential)) {
      throw new Error("Convex key generator returned an invalid credential");
    }
    await keychain.set("convex-admin-credential", credential);
    return credential;
  } finally {
    if (exitTimeout) clearTimeout(exitTimeout);
    if (child && (!processSettled || !stdinSettled)) {
      child.stdin.destroy();
      child.kill("SIGKILL");
      await Promise.race([
        Promise.allSettled([processClosed, stdinCompletion]),
        new Promise((resolvePromise) => {
          setTimeout(resolvePromise, KEYGEN_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    }
    request.fill(0);
    stdout.fill(0);
  }
}

export async function readBuildMarker(paths: Pick<QaliPaths, "config">): Promise<string | null> {
  try {
    const raw = await readFile(join(paths.config, BUILD_MARKER_FILE), "utf8");
    const parsed = JSON.parse(raw) as { buildMarker?: unknown };
    return typeof parsed.buildMarker === "string" ? parsed.buildMarker : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function commitBuildMarker(
  paths: Pick<QaliPaths, "config">,
  buildMarker: string,
): Promise<void> {
  const target = join(paths.config, BUILD_MARKER_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ buildMarker })}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function invalidateBuildMarker(
  paths: Pick<QaliPaths, "config">,
): Promise<void> {
  await rm(join(paths.config, BUILD_MARKER_FILE), { force: true });
}

export async function bootstrapConvex(
  options: ConvexBootstrapOptions,
): Promise<BootstrappedConvexRuntime> {
  const resourcesRoot = await realpath(resolve(options.resourcesRoot));
  const manifest = await readManifest(resourcesRoot);
  const packagedManifest = options.requirePackagedResourceManifest
    ? JSON.parse(
        await readFile(
          join(resourcesRoot, "packaged-resource-manifest.json"),
          "utf8",
        ),
      ) as unknown
    : null;
  const [backendExecutable, cliEntryPath, keygenPath] = await Promise.all([
    verifyResource(
      resourcesRoot,
      selectRuntimeArtifactProof(
        manifest.convex.backend,
        packagedManifest,
        options.requirePackagedResourceManifest,
      ),
    ),
    verifyResource(
      resourcesRoot,
      selectRuntimeArtifactProof(
        manifest.convex.cli,
        packagedManifest,
        options.requirePackagedResourceManifest,
      ),
    ),
    verifyResource(
      resourcesRoot,
      selectRuntimeArtifactProof(
        manifest.convex.keygen,
        packagedManifest,
        options.requirePackagedResourceManifest,
      ),
    ),
  ]);
  const esbuildExecutable = options.requirePackagedResourceManifest
    ? await verifyResource(
        resourcesRoot,
        selectPackagedArtifactProof(PACKAGED_ESBUILD_PATH, packagedManifest),
      )
    : undefined;
  const runtimeModulesRoot = options.requirePackagedResourceManifest
    ? await verifyPackagedDirectory(resourcesRoot, PACKAGED_RUNTIME_MODULES_PATH)
    : undefined;
  if (((await stat(backendExecutable)).mode & 0o111) === 0) {
    throw new Error("Bundled Convex backend is not executable");
  }
  const instanceSecret = await getOrCreateSecret(
    options.keychain,
    "convex-instance-root-secret",
  );
  registerOwnedInstanceSecret(instanceSecret);
  const instanceName = `qali-${options.identity.channel}`;
  const adminCredential = await deriveAdminCredential(
    options.keychain,
    keygenPath,
    instanceName,
    instanceSecret,
  );
  const ports = CHANNEL_PORTS[options.identity.channel];
  const projectDigest = await computeDeployableProjectDigest(options.backendProjectDirectory);
  const buildMarker = `${manifest.convex.backend.commit}:project-v1:${projectDigest}`;
  return {
    backendExecutable,
    databaseDirectory: options.paths.database,
    deploymentUrl: `http://127.0.0.1:${ports.deployment}`,
    siteUrl: `http://127.0.0.1:${ports.site}`,
    instanceName,
    instanceSecret,
    adminCredential,
    expectedVersion: manifest.convex.backend.serverVersion,
    buildMarker,
    cliEntryPath,
    ...(runtimeModulesRoot ? { runtimeModulesRoot } : {}),
    backendProjectDirectory: options.backendProjectDirectory,
    electronExecutable: options.electronExecutable,
    ...(esbuildExecutable ? { esbuildExecutable } : {}),
    nodeModulesPath: options.nodeModulesPath,
    previousBuildMarker: await readBuildMarker(options.paths),
  };
}

type BoundedFetchOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  overallTimeoutMs?: number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;

export async function fetchBounded(
  url: string,
  init: RequestInit = {},
  options: BoundedFetchOptions = {},
): Promise<Response> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? 1_000;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const sleep = options.sleep ?? (async (milliseconds: number) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  });
  for (const duration of [overallTimeoutMs, requestTimeoutMs, retryDelayMs]) {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Invalid Convex readiness timing policy");
    }
  }

  const deadline = now() + overallTimeoutMs;
  let lastError: unknown;
  while (now() < deadline) {
    const remainingMs = deadline - now();
    try {
      const response = await fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
        ),
      });
      if (response.status < 500) return response;
    } catch (error) {
      lastError = error;
    }
    const delayMs = Math.min(retryDelayMs, Math.max(0, deadline - now()));
    if (delayMs > 0) await sleep(delayMs);
  }
  throw new Error("Convex readiness probe timed out", { cause: lastError });
}

async function probeBackendVersion(runtime: ResolvedConvexRuntime): Promise<VersionProof> {
  // The approved backend exposes /instance_version. Probe /version first so a
  // later compatible backend can adopt the documented endpoint without weakening checks.
  let response = await fetchBounded(`${runtime.deploymentUrl}/version`);
  if (response.status === 404) {
    response = await fetchBounded(`${runtime.deploymentUrl}/instance_version`);
  }
  const version = (await response.text()).trim();
  return { status: response.status, version };
}

export function createConvexLifecycleDriver(
  options: ConvexBootstrapOptions,
): ConvexSupervisorDriver {
  const writeLog = createRotatingLogWriter(options.paths.logs);
  const backendOwnerReceipt = join(options.paths.runtime, "convex-backend-owner.json");
  return {
    resolve: async () => await bootstrapConvex(options),
    async createUpgradeBackup(runtime) {
      const resolved = runtime as BootstrappedConvexRuntime;
      const hasDatabaseState = (await readdir(options.paths.database)).length > 0;
      if (
        hasDatabaseState &&
        resolved.previousBuildMarker !== resolved.buildMarker
      ) {
        await createColdBackup(
          {
            root: options.paths.root,
            database: options.paths.database,
            config: options.paths.config,
            backups: options.paths.backups,
          },
          resolved.previousBuildMarker ?? "unmarked-recovery",
        );
      }
    },
    async spawn(runtime) {
      await reclaimVerifiedOrphanBackend(runtime, backendOwnerReceipt);
      return spawnBackend(runtime, writeLog, nodeSpawn, undefined, backendOwnerReceipt);
    },
    async probeVersion(runtime) {
      return await probeBackendVersion(runtime);
    },
    async deploy(runtime) {
      const resolved = runtime as BootstrappedConvexRuntime;
      if (resolved.previousBuildMarker === resolved.buildMarker) return;
      if (!resolved.adminCredential) throw new Error("Convex deployment credential is unavailable");
      await configureLocalAuthEnvironment({
        adminCredential: resolved.adminCredential,
        authChannel: options.identity.channel,
        deploymentUrl: resolved.deploymentUrl,
      });
      await deployConvexProject({
        electronExecutable: resolved.electronExecutable,
        esbuildExecutable: resolved.esbuildExecutable,
        nodeModulesPath: resolved.nodeModulesPath,
        cliEntryPath: resolved.cliEntryPath,
        runtimeModulesRoot: resolved.runtimeModulesRoot,
        backendProjectDirectory: resolved.backendProjectDirectory,
        deploymentUrl: resolved.deploymentUrl,
        adminCredential: resolved.adminCredential,
        authChannel: options.identity.channel,
        schemaPhase: "expand",
      }, writeLog);
    },
    async contract(runtime) {
      const resolved = runtime as BootstrappedConvexRuntime;
      if (!resolved.adminCredential) throw new Error("Convex deployment credential is unavailable");
      await deployConvexProject({
        electronExecutable: resolved.electronExecutable,
        esbuildExecutable: resolved.esbuildExecutable,
        nodeModulesPath: resolved.nodeModulesPath,
        cliEntryPath: resolved.cliEntryPath,
        runtimeModulesRoot: resolved.runtimeModulesRoot,
        backendProjectDirectory: resolved.backendProjectDirectory,
        deploymentUrl: resolved.deploymentUrl,
        adminCredential: resolved.adminCredential,
        authChannel: options.identity.channel,
        schemaPhase: "contract",
      }, writeLog);
    },
    async authenticateIdentity(runtime) {
      const resolved = runtime as BootstrappedConvexRuntime;
      if (!resolved.adminCredential) return false;
      const instance = await fetchBounded(`${resolved.deploymentUrl}/instance_name`);
      if (instance.status !== 200 || (await instance.text()).trim() !== resolved.instanceName) {
        return false;
      }
      const adminProof = await fetchBounded(
        `${resolved.deploymentUrl}/api/list_environment_variables`,
        {
          headers: {
            Authorization: `Convex ${resolved.adminCredential}`,
            "Convex-Client": "qali-desktop-1.0",
          },
        },
        { overallTimeoutMs: 3_000 },
      );
      return adminProof.status === 200;
    },
    async commitBuildMarker(runtime) {
      await commitBuildMarker(options.paths, runtime.buildMarker);
      const sensitive = runtime as { adminCredential?: string };
      if (sensitive.adminCredential) sensitive.adminCredential = "";
    },
  };
}
