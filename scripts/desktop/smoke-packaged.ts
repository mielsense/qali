import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  opendir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { BRIDGE_VERSION } from "@qali/desktop-contracts";

import { verifyFinalApp } from "./verify-app";
import {
  assertOwnedSpawnEvidence,
  parseCompleteSmokeMarker,
} from "./lib/owned-spawn-evidence";

const repositoryRoot = resolve(import.meta.dir, "../..");
const appPath = resolve(repositoryRoot, "dist/Qali.app");
const execFileAsync = promisify(execFile);
const keychainHelper = resolve(
  appPath,
  "Contents/Resources/bin/keychain-helper",
);
const accounts = [
  "convex-instance-root-secret",
  "convex-admin-credential",
  "local-jwt-signing-key",
  "google-oauth-client-config",
  "google-refresh-token",
  "google-account-metadata",
  "google-account-v2-0",
  "google-account-v2-1",
  "google-account-v2-2",
  "google-account-v2-3",
  "google-account-v2-4",
  "google-account-v2-5",
  "google-account-v2-6",
  "google-account-v2-7",
] as const;

type SmokePhase = "seed" | "verify";
type RunningApp = Readonly<{
  child: ChildProcess;
  processSnapshot: Readonly<{
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
  }>;
  output: { stderr: string; stdout: string };
}>;

type PhaseEvidence = Readonly<{
  codexSpawnAttempts: number;
  eventCount: number;
  exportSha256: string;
  googleNetworkAttempts: number;
  pendingCount: number;
  ownedSpawnReceipts: readonly unknown[];
  renderer: Readonly<{
    bodyTextLength: number;
    localStorage: readonly unknown[];
    rootChildCount: number;
    sessionStorage: readonly unknown[];
    title: string;
    url: string;
  }>;
  screenshot: Readonly<{ bytes: number; path: string; sha256: string }>;
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("PACKAGED_SMOKE_PROCESS_TIMEOUT"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolvePromise(code);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

async function writeAuthority(
  root: string,
  applicationAsarSha256: string,
  phase: SmokePhase,
): Promise<{ source: string; nonce: string }> {
  const nonce = randomBytes(32).toString("hex");
  const sentinel = {
    applicationAsarSha256,
    formatVersion: 1,
    nonce,
    phase,
  } as const;
  await writeFile(
    join(root, ".qali-packaged-smoke-authority.json"),
    `${JSON.stringify(sentinel)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(join(root, ".qali-packaged-smoke-authority.json"), 0o600);
  return { source: `${JSON.stringify({ ...sentinel, root })}\n`, nonce };
}

function launch(executable: string): RunningApp {
  const argv: string[] = [];
  const env = {
    HOME: tmpdir(),
    LANG: "C.UTF-8",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: tmpdir(),
  } as const;
  const child = spawn(executable, [], {
    cwd: tmpdir(),
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stderr: "", stdout: "" };
  const append = (field: "stderr" | "stdout", bytes: Buffer) => {
    if (output[field].length < 1024 * 1024)
      output[field] += bytes.toString("utf8");
  };
  child.stdout?.on("data", (bytes: Buffer) => append("stdout", bytes));
  child.stderr?.on("data", (bytes: Buffer) => append("stderr", bytes));
  return { child, output, processSnapshot: { argv, env } };
}

async function prepareSmokeBuild(
  root: string,
  authoritySource: string,
): Promise<string> {
  const smokeApp = join(root, "Qali Packaged Smoke.app");
  if (!(await stat(smokeApp).catch(() => null))) {
    await execFileAsync("/usr/bin/ditto", [appPath, smokeApp]);
  }
  const plist = join(smokeApp, "Contents/Info.plist");
  for (const [key, value] of [
    ["CFBundleIdentifier", "com.qali.desktop.smoke"],
    ["CFBundleShortVersionString", "0.1.0-smoke"],
  ] as const) {
    await execFileAsync("/usr/bin/plutil", [
      "-replace",
      key,
      "-string",
      value,
      plist,
    ]);
  }
  const embeddedAuthority = join(
    smokeApp,
    "Contents/Resources/packaged-smoke-authority.json",
  );
  await writeFile(embeddedAuthority, authoritySource, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(embeddedAuthority, 0o600);
  const authority = JSON.parse(authoritySource) as {
    applicationAsarSha256: string;
    nonce: string;
  };
  const embeddedBuildIdentity = join(
    smokeApp,
    "Contents/Resources/packaged-smoke-build-identity.json",
  );
  await writeFile(
    embeddedBuildIdentity,
    `${JSON.stringify({
      applicationAsarSha256: authority.applicationAsarSha256,
      formatVersion: 1,
      kind: "qali-packaged-smoke-build",
      nonce: authority.nonce,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(embeddedBuildIdentity, 0o600);
  await execFileAsync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    smokeApp,
  ]);
  return join(smokeApp, "Contents/MacOS/Qali");
}

async function waitForMarker(
  child: ChildProcess,
  root: string,
  nonce: string,
  phase: SmokePhase,
): Promise<PhaseEvidence> {
  const marker = join(root, "Qali Test/runtime/packaged-smoke-ready.json");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `PACKAGED_SMOKE_APP_EXITED:${child.exitCode ?? child.signalCode ?? "unknown"}`,
      );
    }
    const source = await readFile(marker, "utf8").catch(() => null);
    if (source !== null) {
      const value = parseCompleteSmokeMarker(source);
      if (value === null) {
        await delay(25);
        continue;
      }
      if (
        value.assistant === "unavailable" &&
        value.bridgeVersion === BRIDGE_VERSION &&
        value.codexSpawnAttempts === 0 &&
        value.formatVersion === 2 &&
        value.googleNetworkAttempts === 0 &&
        value.nonce === nonce &&
        value.phase === phase &&
        value.service === "ready" &&
        Number.isSafeInteger(value.eventCount) &&
        Number.isSafeInteger(value.pendingCount) &&
        (value.eventCount as number) >= 1 &&
        (value.pendingCount as number) >= 1 &&
        typeof value.exportSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.exportSha256) &&
        Array.isArray(value.ownedSpawnReceipts) &&
        typeof value.renderer === "object" &&
        value.renderer !== null &&
        Number.isSafeInteger(
          (value.renderer as Record<string, unknown>).rootChildCount,
        ) &&
        ((value.renderer as Record<string, unknown>).rootChildCount as number) >
          0 &&
        Number.isSafeInteger(
          (value.renderer as Record<string, unknown>).bodyTextLength,
        ) &&
        ((value.renderer as Record<string, unknown>).bodyTextLength as number) >
          0 &&
        typeof value.screenshot === "object" &&
        value.screenshot !== null
      ) {
        const screenshot = value.screenshot as Record<string, unknown>;
        if (
          typeof screenshot.path !== "string" ||
          typeof screenshot.sha256 !== "string" ||
          !Number.isSafeInteger(screenshot.bytes) ||
          (screenshot.bytes as number) < 1
        )
          throw new Error("PACKAGED_SMOKE_SCREENSHOT_INVALID");
        const screenshotBytes = await readFile(screenshot.path);
        if (
          screenshotBytes.byteLength !== screenshot.bytes ||
          sha256(screenshotBytes) !== screenshot.sha256
        )
          throw new Error("PACKAGED_SMOKE_SCREENSHOT_INVALID");
        return value as unknown as PhaseEvidence;
      }
      throw new Error(
        `PACKAGED_SMOKE_MARKER_INVALID:${JSON.stringify(value).slice(0, 2_000)}`,
      );
    }
    await delay(100);
  }
  throw new Error("PACKAGED_SMOKE_READY_TIMEOUT");
}

async function stop(app: RunningApp): Promise<void> {
  app.child.kill("SIGTERM");
  const code = await waitForExit(app.child, 30_000);
  if (code !== 0 && code !== null)
    throw new Error(`PACKAGED_SMOKE_EXIT_${code}`);
}

type KeychainRequest = Readonly<{
  account: (typeof accounts)[number];
  operation: "delete" | "get" | "set";
  service: "com.qali.desktop.test";
  value?: string;
}>;

async function keychainExchange(
  requests: readonly KeychainRequest[],
): Promise<Array<Record<string, unknown>>> {
  const child = spawn(keychainHelper, [], {
    env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on(
    "data",
    (bytes: Buffer) => (stdout += bytes.toString("utf8")),
  );
  child.stderr.on(
    "data",
    (bytes: Buffer) => (stderr += bytes.toString("utf8")),
  );
  child.stdin.end(
    requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
  );
  const code = await waitForExit(child, 10_000);
  const responses = stdout.trim().split("\n").filter(Boolean);
  if (
    code !== 0 ||
    responses.length !== requests.length ||
    responses.some((line) => JSON.parse(line).ok !== true)
  ) {
    throw new Error(
      `PACKAGED_SMOKE_KEYCHAIN_REQUEST_FAILED:${stderr.slice(0, 200)}`,
    );
  }
  return responses.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function cleanupKeychain(): Promise<void> {
  await keychainExchange(
    accounts.map((account) => ({
      account,
      operation: "delete",
      service: "com.qali.desktop.test",
    })),
  );
}

async function seedGoogleCanaries(): Promise<string[]> {
  const clientSecret = `gcs_${randomBytes(32).toString("hex")}`;
  const refreshToken = `grt_${randomBytes(32).toString("hex")}`;
  const subject = `gsub_${randomBytes(24).toString("hex")}`;
  const clientId = `${randomBytes(20).toString("hex")}.apps.googleusercontent.com`;
  const requests: KeychainRequest[] = [
    {
      account: "google-oauth-client-config",
      operation: "set",
      service: "com.qali.desktop.test",
      value: JSON.stringify({ clientId, clientSecret, version: 1 }),
    },
    {
      account: "google-refresh-token",
      operation: "set",
      service: "com.qali.desktop.test",
      value: refreshToken,
    },
    {
      account: "google-account-metadata",
      operation: "set",
      service: "com.qali.desktop.test",
      value: JSON.stringify({
        email: "smoke@example.invalid",
        subject,
        version: 1,
      }),
    },
  ];
  await keychainExchange(requests);
  return [clientSecret, refreshToken, subject];
}

async function readRuntimeSecretCanaries(): Promise<{
  canaries: string[];
  instanceSecret: string;
}> {
  const responses = await keychainExchange(
    accounts.map((account) => ({
      account,
      operation: "get",
      service: "com.qali.desktop.test",
    })),
  );
  const instanceSecret = responses[0]?.value;
  if (
    typeof instanceSecret !== "string" ||
    !/^[a-f0-9]{64}$/.test(instanceSecret)
  ) {
    throw new Error("PACKAGED_SMOKE_INSTANCE_SECRET_MISSING");
  }
  return {
    canaries: responses.flatMap((response) =>
      typeof response.value === "string" && response.value.length > 0
        ? [response.value]
        : [],
    ),
    instanceSecret,
  };
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink())
        await visit(path);
      else if (metadata.isFile() && !metadata.isSymbolicLink())
        files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

async function assertCanariesAbsent(
  canaries: readonly string[],
  surfaces: readonly Readonly<{ name: string; bytes: Uint8Array }>[],
): Promise<void> {
  for (const surface of surfaces) {
    const bytes = Buffer.from(surface.bytes);
    for (const canary of canaries) {
      if (bytes.includes(Buffer.from(canary, "utf8"))) {
        throw new Error(`PACKAGED_SMOKE_SECRET_LEAK:${surface.name}`);
      }
    }
  }
}

async function runSmoke(localDevelopment: boolean): Promise<void> {
  await verifyFinalApp({ localDevelopment });
  const applicationAsarSha256 = sha256(
    await readFile(resolve(appPath, "Contents/Resources/app.asar")),
  );
  const root = await mkdtemp(join(tmpdir(), "qali-packaged-smoke-"));
  await chmod(root, 0o700);
  if (!root.startsWith(`${tmpdir()}/qali-packaged-smoke-`)) {
    throw new Error("PACKAGED_SMOKE_ROOT_INVALID");
  }
  const phases: Array<
    PhaseEvidence & {
      phase: SmokePhase;
      smokeExecutableSha256: string;
    }
  > = [];
  const outputs: RunningApp["output"][] = [];
  const processSnapshots: RunningApp["processSnapshot"][] = [];
  const children: ChildProcess[] = [];
  const duplicateExitCodes: number[] = [];
  try {
    await cleanupKeychain();
    const seededCanaries = await seedGoogleCanaries();
    for (const phase of ["seed", "verify"] as const) {
      const marker = join(root, "Qali Test/runtime/packaged-smoke-ready.json");
      await unlink(marker).catch(() => {});
      const authority = await writeAuthority(
        root,
        applicationAsarSha256,
        phase,
      );
      const smokeExecutable = await prepareSmokeBuild(root, authority.source);
      const smokeExecutableSha256 = sha256(await readFile(smokeExecutable));
      const app = launch(smokeExecutable);
      children.push(app.child);
      outputs.push(app.output);
      processSnapshots.push(app.processSnapshot);
      const state = await waitForMarker(
        app.child,
        root,
        authority.nonce,
        phase,
      );
      phases.push({ ...state, phase, smokeExecutableSha256 });
      if (phase === "seed") {
        const duplicate = launch(smokeExecutable);
        children.push(duplicate.child);
        outputs.push(duplicate.output);
        processSnapshots.push(duplicate.processSnapshot);
        const duplicateExitCode = await waitForExit(duplicate.child, 10_000);
        if (duplicateExitCode !== 0) {
          throw new Error(`PACKAGED_SMOKE_DUPLICATE_EXIT_${duplicateExitCode}`);
        }
        duplicateExitCodes.push(duplicateExitCode);
      }
      await stop(app);
    }

    const runtimeSecrets = await readRuntimeSecretCanaries();
    const canaries = [
      ...new Set([...seededCanaries, ...runtimeSecrets.canaries]),
    ];
    const stableExecutableSha256 = {
      "convex-backend": sha256(
        await readFile(
          resolve(appPath, "Contents/Resources/bin/convex-local-backend"),
        ),
      ),
      "convex-keygen": sha256(
        await readFile(
          resolve(appPath, "Contents/Resources/bin/convex-generate-key"),
        ),
      ),
      "keychain-helper": sha256(
        await readFile(
          resolve(appPath, "Contents/Resources/bin/keychain-helper"),
        ),
      ),
    } as const;
    const ownedSpawnReceipts = phases.flatMap(
      ({ ownedSpawnReceipts }) => ownedSpawnReceipts,
    );
    for (const phase of phases) {
      assertOwnedSpawnEvidence({
        expectedExecutableSha256: {
          ...stableExecutableSha256,
          "convex-deploy-cli": phase.smokeExecutableSha256,
        },
        instanceSecretSha256: sha256(
          Buffer.from(runtimeSecrets.instanceSecret),
        ),
        receipts: phase.ownedSpawnReceipts,
      });
    }
    const observedKinds = new Set(
      ownedSpawnReceipts.flatMap((receipt) =>
        typeof receipt === "object" && receipt !== null && "kind" in receipt
          ? [String(receipt.kind)]
          : [],
      ),
    );
    for (const kind of [
      "convex-backend",
      "convex-deploy-cli",
      "convex-keygen",
      "keychain-helper",
    ]) {
      if (!observedKinds.has(kind)) {
        throw new Error(`PACKAGED_SMOKE_OWNED_SPAWN_MISSING:${kind}`);
      }
    }
    const memorySurfaces: Array<{ name: string; bytes: Uint8Array }> = [
      ...outputs.flatMap(({ stderr, stdout }, index) => [
        { bytes: Buffer.from(stdout), name: `process-${index + 1}-stdout` },
        { bytes: Buffer.from(stderr), name: `process-${index + 1}-stderr` },
      ]),
      {
        bytes: Buffer.from(JSON.stringify(processSnapshots)),
        name: "process-argv-env",
      },
    ];
    const surfaceReceipts: Array<{
      bytes: number;
      name: string;
      sha256: string;
    }> = [];
    for (const surface of memorySurfaces) {
      await assertCanariesAbsent(canaries, [surface]);
      surfaceReceipts.push({
        bytes: surface.bytes.byteLength,
        name: surface.name,
        sha256: sha256(surface.bytes),
      });
    }
    for (const [prefix, scanRoot] of [
      ["runtime", root],
      ["package", appPath],
    ] as const) {
      for (const path of await collectFiles(scanRoot)) {
        const bytes = await readFile(path);
        const surface = { bytes, name: `${prefix}:${path}` };
        await assertCanariesAbsent(canaries, [surface]);
        surfaceReceipts.push({
          bytes: bytes.byteLength,
          name: surface.name,
          sha256: sha256(bytes),
        });
      }
    }
    const database = join(root, "Qali Test/database");
    if (!(await stat(database)).isDirectory())
      throw new Error("PACKAGED_SMOKE_DATABASE_MISSING");
    await cleanupKeychain();
    const smokeEvidence = `${JSON.stringify(
      {
        assistant: "unavailable",
        canaryFingerprints: canaries.map((value) => sha256(Buffer.from(value))),
        duplicateExitCodes,
        formatVersion: 2,
        inspectedSurfaces: surfaceReceipts,
        ownedSpawnReceipts,
        phases,
        processSnapshots,
        twoInstanceGuard: "passed",
      },
      null,
      2,
    )}\n`;
    await assertCanariesAbsent(canaries, [
      {
        bytes: Buffer.from(smokeEvidence),
        name: "smoke-evidence",
      },
    ]);
    await writeFile(
      resolve(repositoryRoot, "dist/qali-smoke-evidence.json"),
      smokeEvidence,
      { encoding: "utf8", mode: 0o600 },
    );
    console.log(
      `Packaged smoke passed: offline create/edit/delete, restart persistence, queue=${phases.at(-1)?.pendingCount}`,
    );
  } catch (error) {
    const bootstrap = await readFile(
      join(root, "packaged-smoke-bootstrap.json"),
      "utf8",
    ).catch(() => "bootstrap unavailable");
    console.error(`packaged smoke bootstrap: ${bootstrap.trim()}`);
    const stage = await readFile(
      join(root, "packaged-smoke-stage.json"),
      "utf8",
    ).catch(() => "stage unavailable");
    console.error(`packaged smoke stage: ${stage.trim()}`);
    const diagnostics = outputs
      .map(
        ({ stderr, stdout }, index) =>
          `process ${index + 1} stdout:\n${stdout.slice(-8_000)}\nprocess ${index + 1} stderr:\n${stderr.slice(-8_000)}`,
      )
      .join("\n");
    if (diagnostics) console.error(diagnostics);
    throw error;
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await waitForExit(child, 30_000).catch(() => child.kill("SIGKILL"));
      }
    }
    await cleanupKeychain().catch(() => {});
    await rm(root, { force: true, recursive: true });
  }
}

const argumentsList = process.argv.slice(2);
if (
  argumentsList.length > 1 ||
  (argumentsList.length === 1 && argumentsList[0] !== "--local-development")
) {
  throw new Error("PACKAGED_SMOKE_ARGUMENT_INVALID");
}
await runSmoke(argumentsList[0] === "--local-development");
