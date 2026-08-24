import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseGoogleDesktopClientId,
  parseGooglePublicDesktopClient,
} from "../../apps/desktop/src/main/google/oauth-client-config";

import {
  collectMachOPaths,
  createPackagedResourceManifest,
  encodePackagedResourceManifest,
  EXPECTED_MACH_O_PATHS,
} from "./lib/app-bundle-verifier";
import {
  collectLocalDevelopmentSourceState,
  collectReleaseSourceState,
  type ReleaseSourceProof,
  verifyReleaseInputAllowlist,
} from "./lib/release-input-allowlist";
import { verifyRawPackagedOutputPolicy } from "./lib/packaged-output-policy";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(import.meta.dir, "../..");

export type BuildAppMode = Readonly<{ localDevelopment: boolean }>;

export function parseBuildAppMode(
  argumentsList: readonly string[],
  continuousIntegration: boolean,
): BuildAppMode {
  if (
    argumentsList.length === 0 ||
    (argumentsList.length === 1 && argumentsList[0] === "--local-development")
  ) {
    const localDevelopment = argumentsList[0] === "--local-development";
    if (localDevelopment && continuousIntegration) {
      throw new Error("LOCAL_DEVELOPMENT_PACKAGE_FORBIDDEN_IN_CI");
    }
    return { localDevelopment };
  }
  throw new Error("BUILD_APP_ARGUMENT_INVALID");
}

export function assertReleaseHost(
  platform: string,
  architecture: string,
): void {
  if (platform !== "darwin" || architecture !== "arm64") {
    throw new Error("Qali packaging requires darwin-arm64");
  }
}

export function electronBuilderArguments(root: string): string[] {
  return [
    "--config",
    resolve(root, "apps/desktop/electron-builder.yml"),
    "--mac",
    "dir",
    "--arm64",
    "--publish",
    "never",
  ];
}

export function assertReleaseOutput(root: string, output: string): string {
  const expected = resolve(root, "dist");
  const candidate = resolve(output);
  if (
    candidate !== expected ||
    basename(candidate) !== "dist" ||
    candidate === resolve(root)
  ) {
    throw new Error("REFUSING_UNSAFE_RELEASE_OUTPUT");
  }
  return candidate;
}

export function releasePath(executable: string): string {
  return `${dirname(executable)}:/opt/homebrew/bin:/usr/bin:/bin`;
}

export function encodePackagedGoogleClientResource(
  publicClientSource: string,
  clientSecret: string | undefined,
): string {
  if (!clientSecret) throw new Error("GOOGLE_OAUTH_RELEASE_SECRET_MISSING");
  let publicClient: unknown;
  try {
    publicClient = JSON.parse(publicClientSource);
  } catch {
    throw new Error("GOOGLE_OAUTH_CLIENT_INVALID");
  }
  const clientId = parseGoogleDesktopClientId(publicClient);
  const client = parseGooglePublicDesktopClient({ clientId, clientSecret });
  return `${JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret })}\n`;
}

/** Reuse an already installed client only for an explicit local package. The
 * value never enters source, logs, or the release-input ledger. */
export function installedGoogleClientSecret(
  publicClientSource: string,
  installedClientSource: string,
): string {
  let publicValue: unknown;
  let installedValue: unknown;
  try {
    publicValue = JSON.parse(publicClientSource);
    installedValue = JSON.parse(installedClientSource);
  } catch {
    throw new Error("INSTALLED_GOOGLE_OAUTH_CLIENT_INVALID");
  }
  const publicClientId = parseGoogleDesktopClientId(publicValue);
  const installedClient = parseGooglePublicDesktopClient(installedValue);
  if (installedClient.clientId !== publicClientId) {
    throw new Error("INSTALLED_GOOGLE_OAUTH_CLIENT_MISMATCH");
  }
  return installedClient.clientSecret;
}

export async function resolveGoogleClientSecret(
  publicClientSource: string,
  localDevelopment: boolean,
): Promise<string | undefined> {
  if (process.env.QALI_GOOGLE_OAUTH_CLIENT_SECRET) {
    return process.env.QALI_GOOGLE_OAUTH_CLIENT_SECRET;
  }
  if (!localDevelopment) return undefined;
  let installedClientSource: string;
  try {
    installedClientSource = await readFile(
      "/Applications/Qali.app/Contents/Resources/google-oauth-client.json",
      "utf8",
    );
  } catch {
    throw new Error("LOCAL_GOOGLE_OAUTH_CLIENT_UNAVAILABLE");
  }
  return installedGoogleClientSecret(publicClientSource, installedClientSource);
}

export function encodeDesktopUpdatePolicy(enabled: boolean): string {
  return `${JSON.stringify({
    formatVersion: 1,
    enabled,
    channel: "latest",
    repository: "NatnaelTaddese/qali",
  })}\n`;
}

function releaseEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    NODE_ENV: "production",
    PATH: releasePath(process.execPath),
  };
  for (const name of ["HOME", "TMPDIR"] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env: releaseEnvironment(),
      shell: false,
      stdio: "inherit",
    });
    child.once("error", () =>
      rejectPromise(new Error(`Release command could not start: ${command}`)),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `Release command failed: ${command} (${code ?? signal ?? "unknown"})`,
          ),
        );
    });
  });
}

async function requirePackagedInput(
  path: string,
  executable: boolean,
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Packaged input is not a regular file: ${path}`);
  }
  if (executable && (metadata.mode & 0o111) === 0) {
    throw new Error(`Packaged input is not executable: ${path}`);
  }
}

export { EXPECTED_MACH_O_PATHS };

const NESTED_CODE_BUNDLES = [
  "Contents/Frameworks/Electron Framework.framework",
  "Contents/Frameworks/Mantle.framework",
  "Contents/Frameworks/ReactiveObjC.framework",
  "Contents/Frameworks/Squirrel.framework",
  "Contents/Frameworks/Qali Helper (GPU).app",
  "Contents/Frameworks/Qali Helper (Plugin).app",
  "Contents/Frameworks/Qali Helper (Renderer).app",
  "Contents/Frameworks/Qali Helper.app",
] as const;

export function buildMacSigningPlan(
  executablePaths: readonly string[],
): string[] {
  const expected = [...EXPECTED_MACH_O_PATHS].sort();
  const actual = [...executablePaths].sort();
  if (
    actual.length !== expected.length ||
    actual.some((path, index) => path !== expected[index])
  ) {
    throw new Error("PACKAGED_CODE_INVENTORY_MISMATCH");
  }
  return [...expected, ...NESTED_CODE_BUNDLES, "."];
}

export function codesignArguments(path: string): string[] {
  return ["--force", "--sign", "-", path];
}

export function plistHardeningOperations(): string[][] {
  return [
    [
      "-replace",
      "NSAppTransportSecurity.NSAllowsArbitraryLoads",
      "-bool",
      "NO",
    ],
    ["-remove", "NSAudioCaptureUsageDescription"],
    ["-remove", "NSBluetoothAlwaysUsageDescription"],
    ["-remove", "NSBluetoothPeripheralUsageDescription"],
    ["-remove", "NSCameraUsageDescription"],
    ["-remove", "NSMicrophoneUsageDescription"],
  ];
}

async function hardenGeneratedPlist(app: string): Promise<void> {
  const plist = join(app, "Contents/Info.plist");
  for (const operation of plistHardeningOperations()) {
    await run("/usr/bin/plutil", [...operation, plist], repositoryRoot);
  }
}

async function configureDesktopUpdatePolicy(app: string): Promise<void> {
  await writeFile(
    join(app, "Contents/Resources/update-policy.json"),
    encodeDesktopUpdatePolicy(process.env.QALI_RELEASE_BUILD === "1"),
    { encoding: "utf8", mode: 0o644 },
  );
}

async function sealPackagedResources(
  app: string,
  sourceProof: ReleaseSourceProof,
): Promise<void> {
  const resources = join(app, "Contents/Resources");
  const actualCode = await collectMachOPaths(app);
  const signingPlan = buildMacSigningPlan(actualCode);
  for (const path of signingPlan.slice(0, -1)) {
    await run(
      "/usr/bin/codesign",
      codesignArguments(join(app, path)),
      repositoryRoot,
    );
  }
  const manifest = await createPackagedResourceManifest(
    app,
    repositoryRoot,
    sourceProof,
  );
  await writeFile(
    join(resources, "packaged-resource-manifest.json"),
    encodePackagedResourceManifest(manifest),
    { encoding: "utf8", mode: 0o644 },
  );
  await run("/usr/bin/codesign", codesignArguments(app), repositoryRoot);
}

async function buildApp(mode: BuildAppMode): Promise<void> {
  assertReleaseHost(process.platform, process.arch);
  await verifyReleaseInputAllowlist(repositoryRoot);
  const sourceProof = mode.localDevelopment
    ? await collectLocalDevelopmentSourceState(repositoryRoot)
    : await collectReleaseSourceState(repositoryRoot);
  const output = assertReleaseOutput(
    repositoryRoot,
    join(repositoryRoot, "dist"),
  );
  const desktopRoot = join(repositoryRoot, "apps/desktop");
  await Promise.all([
    requirePackagedInput(
      join(desktopRoot, "resources/google-oauth-client.json"),
      false,
    ),
    requirePackagedInput(
      join(desktopRoot, "resources/bin/keychain-helper"),
      true,
    ),
    requirePackagedInput(
      join(desktopRoot, "resources/bin/convex-local-backend"),
      true,
    ),
    requirePackagedInput(
      join(desktopRoot, "resources/bin/convex-generate-key"),
      true,
    ),
    requirePackagedInput(
      join(desktopRoot, "resources/convex-cli/cli.bundle.cjs"),
      false,
    ),
  ]);

  await rm(output, { force: true, recursive: true });
  await mkdir(output, { mode: 0o700, recursive: false });
  await run(
    process.execPath,
    ["run", "desktop:verify-release-manifest"],
    repositoryRoot,
  );
  await run(process.execPath, ["run", "build"], desktopRoot);
  const releaseInputsRoot = join(output, ".release-inputs");
  await mkdir(releaseInputsRoot, { mode: 0o700 });
  const googlePublicClientSource = await readFile(
    join(desktopRoot, "resources/google-oauth-client.json"),
    "utf8",
  );
  await writeFile(
    join(releaseInputsRoot, "google-oauth-client.json"),
    encodePackagedGoogleClientResource(
      googlePublicClientSource,
      await resolveGoogleClientSecret(
        googlePublicClientSource,
        mode.localDevelopment,
      ),
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    await run(
      join(desktopRoot, "node_modules/.bin/electron-builder"),
      electronBuilderArguments(repositoryRoot),
      desktopRoot,
    );
  } finally {
    await rm(releaseInputsRoot, { force: true, recursive: true });
  }

  const builderRoot = join(output, ".electron-builder");
  const candidates = [
    join(builderRoot, "mac-arm64", "Qali.app"),
    join(builderRoot, "mac", "Qali.app"),
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if ((await lstat(candidate).catch(() => null))?.isDirectory())
      existing.push(candidate);
  }
  if (existing.length !== 1) {
    throw new Error(
      "electron-builder did not produce one darwin-arm64 Qali.app",
    );
  }
  // This comparison intentionally precedes every mutation, manifest creation,
  // and signing operation. Raw builder output cannot define its own policy.
  await verifyRawPackagedOutputPolicy(existing[0]!, repositoryRoot);
  await hardenGeneratedPlist(existing[0]!);
  await configureDesktopUpdatePolicy(existing[0]!);
  await sealPackagedResources(existing[0]!, sourceProof);
  await rename(existing[0]!, join(output, "Qali.app"));
  await rm(builderRoot, { force: true, recursive: true });
  console.log(`Packaged ${join(output, "Qali.app")}`);
}

if (resolve(process.argv[1] ?? "") === resolve(scriptPath)) {
  await buildApp(
    parseBuildAppMode(process.argv.slice(2), process.env.CI === "true"),
  );
}
