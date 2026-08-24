import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { buildMacSigningPlan, EXPECTED_MACH_O_PATHS } from "./build-app";
import { collectMachOPaths } from "./lib/app-bundle-verifier";
import { verifyFinalApp } from "./verify-app";

const repositoryRoot = resolve(import.meta.dir, "../..");
const appPath = resolve(repositoryRoot, "dist/Qali.app");
const releaseOutput = resolve(repositoryRoot, "dist/release");
const mainEntitlements = resolve(
  repositoryRoot,
  "apps/desktop/build/entitlements.mac.plist",
);
const inheritedEntitlements = resolve(
  repositoryRoot,
  "apps/desktop/build/entitlements.mac.inherit.plist",
);

type NotaryCredentials = Readonly<{
  issuer: string;
  keyId: string;
  keyPath: string;
}>;

type CommandResult = Readonly<{ stderr: string; stdout: string }>;

export function assertReleaseTag(version: string, tag: string): void {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("RELEASE_TAG_INVALID");
  if (tag !== `v${version}`) throw new Error("RELEASE_TAG_VERSION_MISMATCH");
}

export function releaseCodesignArguments(
  path: string,
  identity: string,
  entitlements?: string,
): string[] {
  return [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    ...(entitlements ? ["--entitlements", entitlements] : []),
    "--sign",
    identity,
    path,
  ];
}

export function releaseArtifactBuilderArguments(
  root: string,
  signedAppPath: string,
): string[] {
  return [
    "--config",
    resolve(root, "apps/desktop/electron-builder.release.yml"),
    "--prepackaged",
    signedAppPath,
    "--mac",
    "dmg",
    "zip",
    "--arm64",
    "--publish",
    "never",
  ];
}

export function releaseArtifactNames(version: string): string[] {
  return [
    `Qali-${version}-arm64.dmg`,
    `Qali-${version}-arm64.dmg.blockmap`,
    `Qali-${version}-arm64.zip`,
    `Qali-${version}-arm64.zip.blockmap`,
    "latest-mac.yml",
  ];
}

type UpdateArtifactDescriptor = Readonly<{ bytes: number; sha512: string }>;

function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function assertUpdateMetadata(
  source: string,
  version: string,
  expected: Readonly<Record<string, UpdateArtifactDescriptor>>,
): void {
  const lines = source.split(/\r?\n/);
  const declaredVersion = lines
    .find((line) => line.startsWith("version:"))
    ?.slice("version:".length);
  if (
    declaredVersion === undefined ||
    yamlScalar(declaredVersion) !== version
  ) {
    throw new Error("UPDATE_METADATA_VERSION_MISMATCH");
  }

  const declaredFiles: Record<string, Partial<UpdateArtifactDescriptor>> = {};
  let currentUrl: string | null = null;
  for (const line of lines) {
    const url = line.match(/^\s{2}- url:\s*(.+)$/);
    if (url) {
      currentUrl = yamlScalar(url[1]!);
      declaredFiles[currentUrl] = {};
      continue;
    }
    if (currentUrl === null) continue;
    const hash = line.match(/^\s{4}sha512:\s*(.+)$/);
    if (hash) {
      declaredFiles[currentUrl]!.sha512 = yamlScalar(hash[1]!);
      continue;
    }
    const size = line.match(/^\s{4}size:\s*(\d+)$/);
    if (size) declaredFiles[currentUrl]!.bytes = Number(size[1]);
  }

  for (const [name, descriptor] of Object.entries(expected)) {
    const actual = declaredFiles[name];
    if (
      actual?.bytes !== descriptor.bytes ||
      actual.sha512 !== descriptor.sha512
    ) {
      throw new Error("UPDATE_METADATA_ARTIFACT_MISMATCH");
    }
  }
  if (Object.keys(declaredFiles).length !== Object.keys(expected).length) {
    throw new Error("UPDATE_METADATA_ARTIFACT_MISMATCH");
  }

  const expectedZip = `Qali-${version}-arm64.zip`;
  const declaredPath = lines
    .find((line) => line.startsWith("path:"))
    ?.slice("path:".length);
  const declaredPrimaryHash = lines
    .find((line) => line.startsWith("sha512:"))
    ?.slice("sha512:".length);
  if (
    declaredPath === undefined ||
    yamlScalar(declaredPath) !== expectedZip ||
    declaredPrimaryHash === undefined ||
    yamlScalar(declaredPrimaryHash) !== expected[expectedZip]?.sha512
  ) {
    throw new Error("UPDATE_METADATA_PRIMARY_ARTIFACT_MISMATCH");
  }
}

export function notarytoolSubmitArguments(
  archive: string,
  credentials: NotaryCredentials,
): string[] {
  return [
    "notarytool",
    "submit",
    archive,
    "--key",
    credentials.keyPath,
    "--key-id",
    credentials.keyId,
    "--issuer",
    credentials.issuer,
    "--wait",
    "--output-format",
    "json",
  ];
}

export function parseAcceptedNotaryResult(source: string): {
  id: string;
  status: "Accepted";
} {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("NOTARIZATION_RESPONSE_INVALID");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test((value as Record<string, string>).id) ||
    (value as Record<string, unknown>).status !== "Accepted"
  ) {
    throw new Error("NOTARIZATION_REJECTED");
  }
  return {
    id: (value as Record<string, string>).id,
    status: "Accepted",
  };
}

function releaseEnvironment(includeGoogleSecret: boolean): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    NODE_ENV: "production",
    PATH: `${resolve(process.execPath, "..")}:/opt/homebrew/bin:/usr/bin:/bin`,
    QALI_RELEASE_BUILD: "1",
  };
  for (const name of ["HOME", "TMPDIR"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  if (includeGoogleSecret) {
    environment.QALI_GOOGLE_OAUTH_CLIENT_SECRET = requiredEnvironment(
      "QALI_GOOGLE_OAUTH_CLIENT_SECRET",
    );
  }
  return environment;
}

async function run(
  command: string,
  args: readonly string[],
  options: Readonly<{
    capture?: boolean;
    cwd?: string;
    includeGoogleSecret?: boolean;
  }> = {},
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const capture = options.capture === true;
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: releaseEnvironment(options.includeGoogleSecret === true),
      shell: false,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stderr = "";
    let stdout = "";
    if (capture) {
      child.stdout?.on("data", (bytes: Buffer) => {
        if (stdout.length < 1024 * 1024) stdout += bytes.toString("utf8");
      });
      child.stderr?.on("data", (bytes: Buffer) => {
        if (stderr.length < 1024 * 1024) stderr += bytes.toString("utf8");
      });
    }
    child.once("error", () =>
      rejectPromise(
        new Error(`RELEASE_COMMAND_START_FAILED:${basename(command)}`),
      ),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise({ stderr, stdout });
      else
        rejectPromise(
          new Error(
            `RELEASE_COMMAND_FAILED:${basename(command)}:${code ?? signal ?? "unknown"}`,
          ),
        );
    });
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`RELEASE_ENV_MISSING:${name}`);
  return value;
}

async function ensureRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`RELEASE_INPUT_INVALID:${basename(path)}`);
  }
}

async function signApplication(identity: string): Promise<void> {
  const actualCode = await collectMachOPaths(appPath);
  const plan = buildMacSigningPlan(actualCode);
  if (plan.length !== EXPECTED_MACH_O_PATHS.length + 9) {
    throw new Error("RELEASE_SIGNING_PLAN_INVALID");
  }
  for (const relativePath of plan) {
    const absolutePath =
      relativePath === "." ? appPath : join(appPath, relativePath);
    const entitlements =
      relativePath === "."
        ? mainEntitlements
        : relativePath.endsWith(".app")
          ? inheritedEntitlements
          : undefined;
    await run(
      "/usr/bin/codesign",
      releaseCodesignArguments(absolutePath, identity, entitlements),
    );
    await run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      absolutePath,
    ]);
  }
  await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

async function writeReleaseChecksums(
  paths: readonly string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const path of paths)
    hashes[basename(path)] = sha256(await readFile(path));
  const lines = Object.entries(hashes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, hash]) => `${hash}  ${name}`);
  await writeFile(
    join(releaseOutput, "SHA256SUMS.txt"),
    `${lines.join("\n")}\n`,
    {
      encoding: "utf8",
      mode: 0o644,
    },
  );
  return hashes;
}

async function releaseMac(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("QALI_RELEASE_REQUIRES_DARWIN_ARM64");
  }
  const packageDocument = JSON.parse(
    await readFile(
      resolve(repositoryRoot, "apps/desktop/package.json"),
      "utf8",
    ),
  ) as { version?: unknown };
  if (typeof packageDocument.version !== "string") {
    throw new Error("RELEASE_VERSION_INVALID");
  }
  const version = packageDocument.version;
  assertReleaseTag(version, requiredEnvironment("QALI_RELEASE_TAG"));
  const identity = requiredEnvironment("QALI_MACOS_SIGNING_IDENTITY");
  const teamId = requiredEnvironment("APPLE_TEAM_ID");
  const credentials: NotaryCredentials = {
    issuer: requiredEnvironment("APPLE_API_ISSUER"),
    keyId: requiredEnvironment("APPLE_API_KEY_ID"),
    keyPath: requiredEnvironment("APPLE_API_KEY_PATH"),
  };
  await ensureRegularFile(credentials.keyPath);
  await ensureRegularFile(mainEntitlements);
  await ensureRegularFile(inheritedEntitlements);

  await run(process.execPath, ["run", "desktop:package"], {
    includeGoogleSecret: true,
  });
  await signApplication(identity);

  const signature = await run(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", appPath],
    { capture: true },
  );
  if (!signature.stderr.includes(`TeamIdentifier=${teamId}`)) {
    throw new Error("RELEASE_SIGNING_TEAM_MISMATCH");
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "qali-release-"));
  let notarization: { id: string; status: "Accepted" };
  try {
    const submission = join(temporaryRoot, `Qali-${version}-notary.zip`);
    await run("/usr/bin/ditto", [
      "-c",
      "-k",
      "--keepParent",
      "--sequesterRsrc",
      appPath,
      submission,
    ]);
    const result = await run(
      "/usr/bin/xcrun",
      notarytoolSubmitArguments(submission, credentials),
      { capture: true },
    );
    notarization = parseAcceptedNotaryResult(result.stdout);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }

  await run("/usr/bin/xcrun", ["stapler", "staple", appPath]);
  await run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  await run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    appPath,
  ]);
  await verifyFinalApp({
    notarizationId: notarization.id,
    signature: "Developer ID (hardened runtime, notarized, stapled)",
  });

  await rm(releaseOutput, { force: true, recursive: true });
  await mkdir(releaseOutput, { recursive: true, mode: 0o700 });
  await run(
    resolve(repositoryRoot, "apps/desktop/node_modules/.bin/electron-builder"),
    releaseArtifactBuilderArguments(repositoryRoot, appPath),
    { cwd: resolve(repositoryRoot, "apps/desktop") },
  );
  await rm(join(releaseOutput, ".icon-icns"), {
    force: true,
    recursive: true,
  });

  const artifactPaths = releaseArtifactNames(version).map((name) =>
    join(releaseOutput, name),
  );
  for (const path of artifactPaths) await ensureRegularFile(path);
  await run("/usr/bin/hdiutil", ["verify", artifactPaths[0]!]);
  const updateArtifacts = Object.fromEntries(
    await Promise.all(
      [`Qali-${version}-arm64.dmg`, `Qali-${version}-arm64.zip`].map(
        async (name) => {
          const bytes = await readFile(join(releaseOutput, name));
          return [name, { bytes: bytes.byteLength, sha512: sha512(bytes) }];
        },
      ),
    ),
  );
  assertUpdateMetadata(
    await readFile(join(releaseOutput, "latest-mac.yml"), "utf8"),
    version,
    updateArtifacts,
  );
  const hashes = await writeReleaseChecksums(artifactPaths);
  const bundleEvidencePath = resolve(
    repositoryRoot,
    "dist/qali-release-evidence.json",
  );
  await ensureRegularFile(bundleEvidencePath);
  await writeFile(
    join(releaseOutput, "bundle-evidence.json"),
    await readFile(bundleEvidencePath),
    { mode: 0o600 },
  );
  const sourceRevision = (
    await run("/usr/bin/git", ["rev-parse", "HEAD"], { capture: true })
  ).stdout.trim();
  await writeFile(
    join(releaseOutput, "release-evidence.json"),
    `${JSON.stringify(
      {
        artifacts: hashes,
        architecture: "arm64",
        bundleId: "com.qali.desktop",
        formatVersion: 1,
        notarization,
        signing: { hardenedRuntime: true, teamId, timestamped: true },
        sourceRevision,
        tag: `v${version}`,
        version,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const unexpected = (await readdir(releaseOutput)).filter(
    (name) =>
      !new Set([
        ...releaseArtifactNames(version),
        "SHA256SUMS.txt",
        "bundle-evidence.json",
        "release-evidence.json",
      ]).has(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`RELEASE_OUTPUT_UNEXPECTED:${unexpected.sort().join(",")}`);
  }
  console.log(
    `Prepared signed Qali ${version} release artifacts in ${releaseOutput}`,
  );
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  await releaseMac();
}
