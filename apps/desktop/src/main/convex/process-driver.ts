import {
  execFile,
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  appendFile,
  chmod,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { redactDiagnostic } from "../diagnostics/redaction";
import { observeOwnedSpawn } from "../processes/owned-spawn-observer";

export type BackendRuntime = Readonly<{
  backendExecutable: string;
  databaseDirectory: string;
  deploymentUrl: string;
  siteUrl: string;
  instanceName: string;
  instanceSecret: string;
}>;

export type BackendSpawnSpec = Readonly<{
  command: string;
  args: string[];
  options: SpawnOptions & {
    cwd: string;
    detached: true;
    env: Record<string, string>;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
  };
}>;

export type OwnedBackendProcess = Readonly<{
  pid: number;
  stdout: Readable;
  stderr: Readable;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  stop(): Promise<void>;
}>;

export type ProcessLogEntry = Readonly<{
  source: "stdout" | "stderr";
  message: string;
}>;

const MINIMAL_BACKEND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  PATH: "/usr/bin:/bin",
});
const MAX_LOG_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const BACKEND_OWNER_RECEIPT_VERSION = 1;
const execFileAsync = promisify(execFile);
const PROCESS_INSPECTION_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
});

type BackendOwnerPayload = Readonly<{
  version: typeof BACKEND_OWNER_RECEIPT_VERSION;
  phase: "intent" | "spawned" | "owned";
  pid: number | null;
  processStartedAtMs: number | null;
  executable: string;
  workingDirectory: string;
  deploymentOrigin: string;
  siteOrigin: string;
  instanceName: string;
  receiptCreatedAtMs: number;
}>;

type BackendOwnerReceipt = Readonly<{
  payload: BackendOwnerPayload;
  signature: string;
}>;

export type BackendProcessIdentity = Readonly<{
  pid: number;
  parentPid: number;
  processGroupId: number;
  executable: string;
  workingDirectory: string;
  startedAtMs: number;
}>;

export type BackendOrphanReclaimDependencies = Readonly<{
  inspectProcess(pid: number): Promise<BackendProcessIdentity | null>;
  findListeningProcess(
    deploymentPort: number,
    sitePort: number,
  ): Promise<number | null>;
  processGroupAlive(pid: number): boolean;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): void;
  sleep(milliseconds: number): Promise<void>;
}>;

function parseLoopbackUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port
  ) {
    throw new Error("Convex endpoints must be explicit HTTP loopback URLs");
  }
  return parsed;
}
export function buildBackendSpawnSpec(
  runtime: BackendRuntime,
): BackendSpawnSpec {
  const deployment = parseLoopbackUrl(runtime.deploymentUrl);
  const site = parseLoopbackUrl(runtime.siteUrl);
  if (
    !runtime.instanceName ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(runtime.instanceName)
  ) {
    throw new Error("Invalid Convex instance name");
  }
  if (!/^[a-f0-9]{64}$/.test(runtime.instanceSecret)) {
    throw new Error("Invalid Convex instance secret");
  }

  return {
    command: runtime.backendExecutable,
    args: [
      "--interface",
      "127.0.0.1",
      "--port",
      deployment.port,
      "--site-proxy-port",
      site.port,
      "--convex-origin",
      deployment.origin,
      "--convex-site",
      site.origin,
      "--local-storage",
      "convex_local_storage",
      "--disable-beacon",
      "--redact-logs-to-client",
      "--instance-name",
      runtime.instanceName,
      "--instance-secret",
      runtime.instanceSecret,
      "convex_local_backend.sqlite3",
    ],
    options: {
      cwd: runtime.databaseDirectory,
      detached: true,
      env: { ...MINIMAL_BACKEND_ENVIRONMENT },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

function redactMessage(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "<redacted>");
  }
  redacted = redacted.replace(
    /((?:admin|instance|refresh|access)[_-]?(?:key|secret|token)\s*[=:]\s*)\S+/gi,
    "$1<redacted>",
  );
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= MAX_LOG_MESSAGE_BYTES) return redacted;
  return `${bytes.subarray(0, MAX_LOG_MESSAGE_BYTES).toString("utf8")}…<truncated>`;
}

export function drainRedactedStream(
  stream: Readable,
  source: ProcessLogEntry["source"],
  secrets: readonly string[],
  write: (entry: ProcessLogEntry) => void,
): () => void {
  let buffered = "";
  const onData = (chunk: Buffer | string) => {
    buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines)
      write({ source, message: redactMessage(line, secrets) });
    if (Buffer.byteLength(buffered, "utf8") > MAX_LOG_MESSAGE_BYTES) {
      write({ source, message: redactMessage(buffered, secrets) });
      buffered = "";
    }
  };
  const onEnd = () => {
    if (buffered) write({ source, message: redactMessage(buffered, secrets) });
    buffered = "";
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

export function createRotatingLogWriter(
  logsDirectory: string,
  fileName = "convex-backend.log",
  maxBytes = 512 * 1024,
): (entry: ProcessLogEntry) => void {
  if (basename(fileName) !== fileName || maxBytes < 4_096) {
    throw new Error("Invalid log rotation configuration");
  }
  const logPath = join(logsDirectory, fileName);
  const rotatedPath = `${logPath}.1`;
  let pending = Promise.resolve();
  return (entry) => {
    // Child output is never serialized. Only a fixed lifecycle observation is
    // collected, redacted, and then encoded for bounded local persistence.
    const line = `${JSON.stringify(
      redactDiagnostic({
        component: "convex",
        toState:
          entry.source === "stderr" ? "process-stderr" : "process-stdout",
        count: 1,
      }),
    )}\n`;
    pending = pending
      .then(async () => {
        const currentSize = await stat(logPath)
          .then((value) => value.size)
          .catch(() => 0);
        if (currentSize + Buffer.byteLength(line, "utf8") > maxBytes) {
          await rename(logPath, rotatedPath).catch(() => undefined);
        }
        await appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
      })
      .catch(() => undefined);
  };
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolvePromise(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolvePromise(true);
    };
    child.once("exit", onExit);
  });
}

function signalOwnedGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function backendOwnerPayload(
  runtime: BackendRuntime,
  phase: BackendOwnerPayload["phase"],
  pid: number | null,
  processStartedAtMs: number | null,
  receiptCreatedAtMs = Date.now(),
): BackendOwnerPayload {
  return {
    version: BACKEND_OWNER_RECEIPT_VERSION,
    phase,
    pid,
    processStartedAtMs,
    executable: resolve(runtime.backendExecutable),
    workingDirectory: resolve(runtime.databaseDirectory),
    deploymentOrigin: parseLoopbackUrl(runtime.deploymentUrl).origin,
    siteOrigin: parseLoopbackUrl(runtime.siteUrl).origin,
    instanceName: runtime.instanceName,
    receiptCreatedAtMs,
  };
}

function signBackendOwnerPayload(
  payload: BackendOwnerPayload,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
}

function validReceiptSignature(
  receipt: BackendOwnerReceipt,
  secret: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(receipt.signature)) return false;
  const expected = Buffer.from(
    signBackendOwnerPayload(receipt.payload, secret),
    "hex",
  );
  const actual = Buffer.from(receipt.signature, "hex");
  return (
    expected.byteLength === actual.byteLength &&
    timingSafeEqual(expected, actual)
  );
}

function parseBackendOwnerReceipt(value: unknown): BackendOwnerReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const payload = receipt.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const candidate = payload as Record<string, unknown>;
  if (
    candidate.version !== BACKEND_OWNER_RECEIPT_VERSION ||
    (candidate.phase !== "intent" &&
      candidate.phase !== "spawned" &&
      candidate.phase !== "owned") ||
    (candidate.pid !== null &&
      (!Number.isSafeInteger(candidate.pid) ||
        (candidate.pid as number) <= 1)) ||
    (candidate.processStartedAtMs !== null &&
      (!Number.isSafeInteger(candidate.processStartedAtMs) ||
        (candidate.processStartedAtMs as number) <= 0)) ||
    (candidate.phase === "intent" &&
      (candidate.pid !== null || candidate.processStartedAtMs !== null)) ||
    (candidate.phase === "spawned" &&
      (candidate.pid === null || candidate.processStartedAtMs !== null)) ||
    (candidate.phase === "owned" &&
      (candidate.pid === null || candidate.processStartedAtMs === null)) ||
    typeof candidate.executable !== "string" ||
    typeof candidate.workingDirectory !== "string" ||
    typeof candidate.deploymentOrigin !== "string" ||
    typeof candidate.siteOrigin !== "string" ||
    typeof candidate.instanceName !== "string" ||
    !Number.isSafeInteger(candidate.receiptCreatedAtMs) ||
    (candidate.receiptCreatedAtMs as number) <= 0 ||
    typeof receipt.signature !== "string"
  ) {
    return null;
  }
  return {
    payload: candidate as unknown as BackendOwnerPayload,
    signature: receipt.signature,
  };
}

async function writeBackendOwnerReceipt(
  runtime: BackendRuntime,
  receiptPath: string,
  phase: BackendOwnerPayload["phase"],
  pid: number | null,
  processStartedAtMs: number | null,
  receiptCreatedAtMs: number,
): Promise<void> {
  const payload = backendOwnerPayload(
    runtime,
    phase,
    pid,
    processStartedAtMs,
    receiptCreatedAtMs,
  );
  const receipt: BackendOwnerReceipt = {
    payload,
    signature: signBackendOwnerPayload(payload, runtime.instanceSecret),
  };
  const temporary = join(
    dirname(receiptPath),
    `.${basename(receiptPath)}.${process.pid}.${pid ?? "intent"}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, receiptPath);
    await chmod(receiptPath, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function inspectBackendProcess(
  pid: number,
): Promise<BackendProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const field = async (name: "ppid" | "pgid" | "comm") => {
      const { stdout } = await execFileAsync(
        "/bin/ps",
        ["-p", String(pid), "-o", `${name}=`],
        {
          timeout: 1_000,
          maxBuffer: 4_096,
          env: PROCESS_INSPECTION_ENVIRONMENT,
        },
      );
      return stdout.trim();
    };
    const [parent, group, executable, startedAt, cwdResult] = await Promise.all(
      [
        field("ppid"),
        field("pgid"),
        field("comm"),
        execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
          timeout: 1_000,
          maxBuffer: 4_096,
          env: PROCESS_INSPECTION_ENVIRONMENT,
        }).then(({ stdout }) => Date.parse(stdout.trim())),
        execFileAsync(
          "/usr/sbin/lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
          {
            timeout: 1_000,
            maxBuffer: 4_096,
            env: PROCESS_INSPECTION_ENVIRONMENT,
          },
        ),
      ],
    );
    const cwd = cwdResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    const parentPid = Number(parent);
    const processGroupId = Number(group);
    if (
      !Number.isSafeInteger(parentPid) ||
      !Number.isSafeInteger(processGroupId) ||
      !Number.isFinite(startedAt) ||
      !executable ||
      !cwd
    ) {
      return null;
    }
    return {
      pid,
      parentPid,
      processGroupId,
      executable: resolve(executable),
      workingDirectory: resolve(cwd),
      startedAtMs: startedAt,
    };
  } catch {
    return null;
  }
}

async function listeningPids(port: number): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      {
        timeout: 1_000,
        maxBuffer: 4_096,
        env: PROCESS_INSPECTION_ENVIRONMENT,
      },
    );
    return new Set(
      stdout
        .split(/\r?\n/)
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => Number(line.slice(1)))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 1),
    );
  } catch {
    return new Set();
  }
}

async function findListeningBackendProcess(
  deploymentPort: number,
  sitePort: number,
): Promise<number | null> {
  const [deploymentPids, sitePids] = await Promise.all([
    listeningPids(deploymentPort),
    listeningPids(sitePort),
  ]);
  const candidates = [...deploymentPids].filter((pid) => sitePids.has(pid));
  return candidates.length === 1 ? candidates[0]! : null;
}

function ownedGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const DEFAULT_ORPHAN_RECLAIM_DEPENDENCIES: BackendOrphanReclaimDependencies = {
  inspectProcess: inspectBackendProcess,
  findListeningProcess: findListeningBackendProcess,
  processGroupAlive: ownedGroupAlive,
  signalProcessGroup: signalOwnedGroup,
  sleep: async (milliseconds) => {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
  },
};

async function waitForOwnedGroupDrain(
  pid: number,
  dependencies: BackendOrphanReclaimDependencies,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (dependencies.processGroupAlive(pid) && Date.now() < deadline) {
    await dependencies.sleep(50);
  }
  return !dependencies.processGroupAlive(pid);
}

async function findFreshIntentProcess(
  deploymentPort: number,
  sitePort: number,
  dependencies: BackendOrphanReclaimDependencies,
): Promise<number | null> {
  // Version-one builds could be terminated after writing an intent but before
  // recording the child PID. A new host must not spend the rest of that old
  // 30-second acquisition window polling an absent process. One immediate port
  // correlation is enough to recover a child that already became ready; newer
  // builds persist the exact PID in the `spawned` phase before slow inspection.
  return await dependencies.findListeningProcess(deploymentPort, sitePort);
}

function sameBackendIdentity(
  first: BackendProcessIdentity,
  second: BackendProcessIdentity,
): boolean {
  return (
    first.pid === second.pid &&
    first.parentPid === second.parentPid &&
    first.processGroupId === second.processGroupId &&
    first.executable === second.executable &&
    first.workingDirectory === second.workingDirectory &&
    first.startedAtMs === second.startedAtMs
  );
}

async function captureSpawnedBackendIdentity(
  runtime: BackendRuntime,
  pid: number,
  inspectProcess: BackendOrphanReclaimDependencies["inspectProcess"],
): Promise<BackendProcessIdentity | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const identity = await inspectProcess(pid);
    if (
      identity &&
      identity.pid === pid &&
      identity.processGroupId === pid &&
      resolve(identity.executable) === resolve(runtime.backendExecutable) &&
      resolve(identity.workingDirectory) === resolve(runtime.databaseDirectory)
    ) {
      return identity;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return null;
}

/**
 * Recover only a process proven by Qali's signed receipt and by the live host
 * identity. Port ownership alone is never authority to signal another process.
 */
export async function reclaimVerifiedOrphanBackend(
  runtime: BackendRuntime,
  receiptPath: string,
  dependencies: BackendOrphanReclaimDependencies = DEFAULT_ORPHAN_RECLAIM_DEPENDENCIES,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
): Promise<boolean> {
  let receipt: BackendOwnerReceipt | null = null;
  try {
    receipt = parseBackendOwnerReceipt(
      JSON.parse(await readFile(receiptPath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return false;
  }
  if (!receipt || !validReceiptSignature(receipt, runtime.instanceSecret))
    return false;
  const expected = backendOwnerPayload(
    runtime,
    receipt.payload.phase,
    receipt.payload.pid,
    receipt.payload.processStartedAtMs,
    receipt.payload.receiptCreatedAtMs,
  );
  if (JSON.stringify(receipt.payload) !== JSON.stringify(expected))
    return false;

  const deploymentPort = Number(parseLoopbackUrl(runtime.deploymentUrl).port);
  const sitePort = Number(parseLoopbackUrl(runtime.siteUrl).port);
  const pid =
    receipt.payload.phase === "owned"
      ? receipt.payload.pid
      : receipt.payload.phase === "spawned"
        ? receipt.payload.pid
      : await findFreshIntentProcess(
          deploymentPort,
          sitePort,
          dependencies,
        );
  if (!pid) return false;
  const identity = await dependencies.inspectProcess(pid);
  if (!identity) {
    await rm(receiptPath, { force: true });
    return false;
  }
  const expectedStart = receipt.payload.processStartedAtMs;
  const intentStartIsPlausible =
    receipt.payload.phase !== "owned" &&
    identity.startedAtMs >= receipt.payload.receiptCreatedAtMs - 1_000 &&
    identity.startedAtMs <= receipt.payload.receiptCreatedAtMs + 30_000;
  const ownedStartMatches =
    receipt.payload.phase === "owned" && identity.startedAtMs === expectedStart;
  if (
    identity.parentPid !== 1 ||
    identity.processGroupId !== identity.pid ||
    resolve(identity.executable) !== expected.executable ||
    resolve(identity.workingDirectory) !== expected.workingDirectory ||
    (!intentStartIsPlausible && !ownedStartMatches)
  ) {
    return false;
  }

  const confirmedIdentity = await dependencies.inspectProcess(pid);
  if (!confirmedIdentity || !sameBackendIdentity(identity, confirmedIdentity))
    return false;
  dependencies.signalProcessGroup(pid, "SIGTERM");
  if (!(await waitForOwnedGroupDrain(identity.pid, dependencies, timeoutMs))) {
    const beforeKill = await dependencies.inspectProcess(pid);
    if (!beforeKill || !sameBackendIdentity(identity, beforeKill)) {
      await rm(receiptPath, { force: true });
      return true;
    }
    dependencies.signalProcessGroup(pid, "SIGKILL");
    if (
      !(await waitForOwnedGroupDrain(identity.pid, dependencies, timeoutMs))
    ) {
      throw new Error("Verified orphaned local calendar service did not stop");
    }
  }
  await rm(receiptPath, { force: true });
  return true;
}

export type BackendSpawn = typeof nodeSpawn;

export async function spawnBackend(
  runtime: BackendRuntime,
  writeLog: (entry: ProcessLogEntry) => void,
  spawnProcess: BackendSpawn = nodeSpawn,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  receiptPath?: string,
  inspectProcess: BackendOrphanReclaimDependencies["inspectProcess"] = inspectBackendProcess,
): Promise<OwnedBackendProcess> {
  const spec = buildBackendSpawnSpec(runtime);
  const receiptCreatedAtMs = Date.now();
  if (receiptPath) {
    await writeBackendOwnerReceipt(
      runtime,
      receiptPath,
      "intent",
      null,
      null,
      receiptCreatedAtMs,
    );
  }
  observeOwnedSpawn(
    "convex-backend",
    spec.command,
    spec.args,
    spec.options.env,
  );
  try {
    const child = spawnProcess(
      spec.command,
      spec.args,
      spec.options,
    ) as unknown as ChildProcessWithoutNullStreams;
    return await new Promise((resolveProcess, rejectProcess) => {
      const onRuntimeError = () => {
        writeLog({
          source: "stderr",
          message: "Convex backend process emitted an error",
        });
      };
      const onSpawnError = () => {
        child.off("spawn", onSpawn);
        rejectProcess(new Error("Convex backend could not start"));
      };
      const onSpawn = () => {
        child.off("error", onSpawnError);
        child.on("error", onRuntimeError);
        const pid = child.pid;
        if (!pid) {
          child.off("error", onRuntimeError);
          rejectProcess(
            new Error(
              "Convex backend did not return an owned process identifier",
            ),
          );
          return;
        }
        const removeStdout = drainRedactedStream(
          child.stdout,
          "stdout",
          [runtime.instanceSecret],
          writeLog,
        );
        const removeStderr = drainRedactedStream(
          child.stderr,
          "stderr",
          [runtime.instanceSecret],
          writeLog,
        );
        void (async () => {
          try {
            if (receiptPath) {
              // Persist the exact detached child identity before any process
              // inspection can block. This closes the Force Quit window where
              // the next launch previously had only an anonymous intent and
              // waited up to thirty seconds for port evidence.
              await writeBackendOwnerReceipt(
                runtime,
                receiptPath,
                "spawned",
                pid,
                null,
                receiptCreatedAtMs,
              );
              const identity = await captureSpawnedBackendIdentity(
                runtime,
                pid,
                inspectProcess,
              );
              if (!identity) {
                throw new Error(
                  "Convex backend process identity could not be captured",
                );
              }
              await writeBackendOwnerReceipt(
                runtime,
                receiptPath,
                "owned",
                pid,
                identity.startedAtMs,
                receiptCreatedAtMs,
              );
            }
          } catch {
            signalOwnedGroup(pid, "SIGTERM");
            if (!(await waitForExit(child, stopTimeoutMs))) {
              signalOwnedGroup(pid, "SIGKILL");
              await waitForExit(child, stopTimeoutMs);
            }
            removeStdout();
            removeStderr();
            child.off("error", onRuntimeError);
            rejectProcess(
              new Error(
                "Convex backend ownership receipt could not be secured",
              ),
            );
            return;
          }

          let stopped = false;
          resolveProcess({
            pid,
            stdout: child.stdout,
            stderr: child.stderr,
            once: child.once.bind(child),
            async stop() {
              if (stopped) return;
              stopped = true;
              signalOwnedGroup(pid, "SIGTERM");
              if (!(await waitForExit(child, stopTimeoutMs))) {
                signalOwnedGroup(pid, "SIGKILL");
                await waitForExit(child, stopTimeoutMs);
              }
              if (receiptPath) await rm(receiptPath, { force: true });
              removeStdout();
              removeStderr();
              child.off("error", onRuntimeError);
            },
          });
        })();
      };
      child.once("error", onSpawnError);
      child.once("spawn", onSpawn);
    });
  } catch (error) {
    if (receiptPath)
      await rm(receiptPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
