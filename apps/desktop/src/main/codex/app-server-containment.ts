import { spawn as nodeSpawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { CodexBoundaryError } from "./auth";
import {
  resolveCodexAppServerContainmentAuthority,
  type CodexAppServerContainmentAuthority,
} from "./boundary";
import type {
  CodexAppServerChild,
  CodexAppServerSpawn,
} from "./app-server-driver";
import { proxyPolicyHash, sha256Bytes } from "./manifest";
import {
  CODEX_SANDBOX_METADATA_PATH_COUNT,
  codexSandboxMetadataPathArguments,
} from "./sandbox-metadata";

/**
 * The retained App Server gets the same durable, fail-closed credential store
 * as Qali's one-shot Codex driver. Keeping this invocation exact is part of the
 * containment boundary: authentication may persist in the macOS Keychain, but
 * never in the disposable CODEX_HOME that Qali removes after shutdown.
 */
export const CODEX_APP_SERVER_ARGS = [
  "-c",
  'cli_auth_credentials_store="keyring"',
  "-c",
  "analytics.enabled=false",
  "-c",
  "check_for_update_on_startup=false",
  "app-server",
  "--listen",
  "stdio://",
] as const;

export type CodexAppServerArgs = typeof CODEX_APP_SERVER_ARGS;

export interface CodexAppServerContainment {
  workRoot(): string;
  spawn(args: CodexAppServerArgs): CodexAppServerChild;
  release(child: CodexAppServerChild): Promise<void>;
  close(): Promise<void>;
}

export type CodexSandboxProfileIdentity = Readonly<{
  device: number;
  inode: number;
  realPath: string;
  sha256: string;
}>;

export type CodexAppServerTestHarness = Readonly<{
  kind: "qali-codex-app-server-test-harness";
}>;

export type CodexSandboxAudit = Readonly<{
  defaultDeny: true;
  initialExecutableOnly: true;
  childProcessesDenied: true;
  inboundAndListenersDenied: true;
  genericIpcDenied: true;
  readsRestricted: true;
  writesRestrictedToIsolatedHome: true;
  outboundRestrictedToCapturedProxy: true;
}>;

type Dependencies = Readonly<{
  testHarness?: CodexAppServerTestHarness;
  processGroupAlive?(pid: number): boolean;
  signalOwnedGroup?(child: CodexAppServerChild, signal: NodeJS.Signals): void;
  wait?(milliseconds: number): Promise<void>;
  gracefulMs?: number;
  terminateMs?: number;
  killMs?: number;
}>;

const DEFAULT_GRACEFUL_MS = 100;
const DEFAULT_TERMINATE_MS = 500;
const DEFAULT_KILL_MS = 500;

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalOwnedGroup(
  child: CodexAppServerChild,
  signal: NodeJS.Signals,
): void {
  if (child.killOwnedGroup) {
    child.killOwnedGroup(signal);
    return;
  }
  const pid = child.pid;
  if (pid && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

const TEST_HARNESS_SPAWNS = new WeakMap<object, CodexAppServerSpawn>();

export function createCodexAppServerTestHarness(
  spawnProcess: CodexAppServerSpawn,
): CodexAppServerTestHarness {
  if (
    process.env.NODE_ENV !== "test" ||
    !process.execPath.endsWith("/bun")
  ) {
    throw containmentError(
      "CODEX_TEST_HARNESS_UNAVAILABLE",
      "Codex fake-child harness is available only under the Bun test runner",
    );
  }
  const harness = Object.freeze({
    kind: "qali-codex-app-server-test-harness" as const,
  });
  TEST_HARNESS_SPAWNS.set(harness, spawnProcess);
  return harness;
}

function containmentError(code: string, message: string): CodexBoundaryError {
  return new CodexBoundaryError(code, message);
}

function normalizedPolicy(profile: string): string {
  return profile
    .split("\n")
    .map((line) => line.replace(/;.*$/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

export function captureCodexSandboxProfileIdentity(
  path: string,
): CodexSandboxProfileIdentity {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw containmentError(
        "CODEX_CONTAINMENT_PROFILE_IDENTITY_MISMATCH",
        "Codex app-server sandbox profile identity changed",
      );
    }
    const profile = readFileSync(path);
    auditCodexAppServerSandboxProfile(profile.toString("utf8"));
    return Object.freeze({
      device: metadata.dev,
      inode: metadata.ino,
      realPath: realpathSync(path),
      sha256: sha256Bytes(profile),
    });
  } catch (error) {
    if (error instanceof CodexBoundaryError) throw error;
    throw containmentError(
      "CODEX_CONTAINMENT_PROFILE_IDENTITY_MISMATCH",
      "Codex app-server sandbox profile identity changed",
    );
  }
}

export function verifyCodexSandboxProfileIdentity(
  path: string,
  expected: CodexSandboxProfileIdentity,
): void {
  const observed = captureCodexSandboxProfileIdentity(path);
  if (
    observed.device !== expected.device ||
    observed.inode !== expected.inode ||
    observed.realPath !== expected.realPath ||
    observed.sha256 !== expected.sha256
  ) {
    throw containmentError(
      "CODEX_CONTAINMENT_PROFILE_IDENTITY_MISMATCH",
      "Codex app-server sandbox profile identity changed",
    );
  }
}

export function auditCodexAppServerSandboxProfile(profile: string): CodexSandboxAudit {
  const policy = normalizedPolicy(profile);
  const exactExec = '(allow process-exec (literal (param "CODEX_EXECUTABLE")))';
  const exactProxy = '(allow network-outbound (remote tcp (param "CODEX_PROXY_ENDPOINT")))';
  const metadataPathParameters = Array.from(
    { length: CODEX_SANDBOX_METADATA_PATH_COUNT },
    (_, index) => `CODEX_METADATA_PATH_${index}`,
  );
  const exactMetadataRead = `(allow file-read-metadata ${metadataPathParameters
    .map((name) => `(literal (param "${name}"))`)
    .join(" ")})`;
  const exactHomeRead = '(literal (param "CODEX_HOME"))';
  const exactCwdRead = '(literal (param "CODEX_CWD"))';
  const exactHomeWrite = '(allow file-write* (subpath (param "CODEX_HOME")))';
  const exactNullWrite = '(allow file-write-data (literal "/dev/null"))';
  const permittedPaths = new Set([
    "/",
    "/System/Library",
    "/usr/lib",
    "/usr/share/locale",
    "/private/var/db/timezone",
    "/dev/null",
    "/dev/random",
    "/dev/urandom",
  ]);
  const quotedPaths = [...policy.matchAll(/\((?:literal|subpath) "(\/[^"]*)"\)/g)]
    .map((match) => match[1]!);
  const machNames = [...policy.matchAll(/\(global-name "([^"]+)"\)/g)]
    .map((match) => match[1]!);
  const parameterNames = [...policy.matchAll(/\(param "([^"]+)"\)/g)]
    .map((match) => match[1]!);
  const permittedMachNames = new Set([
    "com.apple.securityd",
    "com.apple.SecurityServer",
    "com.apple.cfprefsd.agent",
    "com.apple.system.logger",
  ]);
  const permittedParameterNames = new Set([
    "CODEX_EXECUTABLE",
    "CODEX_SCHEMA",
    "CODEX_HOME",
    "CODEX_CWD",
    "CODEX_PROXY_ENDPOINT",
    ...metadataPathParameters,
  ]);

  const valid =
    policy.includes("(version 1)") &&
    policy.includes("(deny default)") &&
    occurrences(policy, "process-exec") === 1 &&
    policy.includes(exactExec) &&
    !/process-fork|process-exec-interpreter|process-exec\s*\)/.test(policy) &&
    occurrences(policy, "process-info*") === 1 &&
    policy.includes("(allow process-info* (target self))") &&
    occurrences(policy, "(allow signal") === 1 &&
    policy.includes("(allow signal (target self))") &&
    !/network-inbound|network-listen|network-bind|network\*/.test(policy) &&
    occurrences(policy, "network-outbound") === 1 &&
    policy.includes(exactProxy) &&
    !/mach-register|system-socket|network-local|\(allow ipc/.test(policy) &&
    occurrences(policy, "mach-lookup") === permittedMachNames.size &&
    machNames.every((name) => permittedMachNames.has(name)) &&
    parameterNames.every((name) => permittedParameterNames.has(name)) &&
    quotedPaths.every((path) => permittedPaths.has(path)) &&
    occurrences(policy, "file-read-metadata") === 1 &&
    policy.includes(exactMetadataRead) &&
    occurrences(policy, "(allow file-read*") === 1 &&
    policy.includes(exactHomeRead) &&
    policy.includes(exactCwdRead) &&
    occurrences(policy, "file-write") === 2 &&
    policy.includes(exactHomeWrite) &&
    policy.includes(exactNullWrite) &&
    !policy.includes('(subpath "/")');
  if (!valid) {
    throw containmentError(
      "CODEX_SANDBOX_POLICY_BROADENED",
      "Codex app-server sandbox policy grants unexpected authority",
    );
  }
  return {
    defaultDeny: true,
    initialExecutableOnly: true,
    childProcessesDenied: true,
    inboundAndListenersDenied: true,
    genericIpcDenied: true,
    readsRestricted: true,
    writesRestrictedToIsolatedHome: true,
    outboundRestrictedToCapturedProxy: true,
  };
}

export async function createCodexAppServerContainment(
  authority: CodexAppServerContainmentAuthority,
  dependencies: Dependencies = {},
): Promise<CodexAppServerContainment> {
  const resolved = resolveCodexAppServerContainmentAuthority(authority);
  const boundary = resolved.boundary;
  if (
    !isAbsolute(boundary.codexHome) ||
    !isAbsolute(boundary.cwd) ||
    boundary.codexHome === "/" ||
    boundary.cwd === "/" ||
    boundary.codexHome === boundary.cwd
  ) {
    throw containmentError(
      "CODEX_CONTAINMENT_PATH_INVALID",
      "Codex app-server containment paths are invalid",
    );
  }
  if ((await readdir(boundary.cwd)).length !== 0) {
    throw containmentError(
      "CODEX_WORK_ROOT_NOT_EMPTY",
      "Codex app-server work root must be empty",
    );
  }
  try {
    const credentials = lstatSync(join(boundary.codexHome, "auth.json"));
    if (credentials) {
      throw containmentError(
        "CODEX_FILE_CREDENTIALS",
        "Codex file credentials are forbidden",
      );
    }
  } catch (error) {
    if (error instanceof CodexBoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw containmentError(
        "CODEX_FILE_CREDENTIALS",
        "Codex credential-file state is untrusted",
      );
    }
  }
  const profileIdentity = captureCodexSandboxProfileIdentity(
    boundary.sandboxProfilePath,
  );
  if (profileIdentity.sha256 !== resolved.profileSha256) {
    throw containmentError(
      "CODEX_CONTAINMENT_HASH_MISMATCH",
      "Codex app-server sandbox profile changed",
    );
  }
  const spawnProcess = dependencies.testHarness === undefined
    ? (nodeSpawn as unknown as CodexAppServerSpawn)
    : TEST_HARNESS_SPAWNS.get(dependencies.testHarness);
  if (!spawnProcess) {
    throw containmentError(
      "CODEX_TEST_HARNESS_REQUIRED",
      "Application-owned Codex fake-child harness is required",
    );
  }
  const children = new Set<CodexAppServerChild>();
  const ownedChildren = new WeakSet<CodexAppServerChild>();
  const observedClosed = new WeakSet<CodexAppServerChild>();
  const releases = new WeakMap<CodexAppServerChild, Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const wait = dependencies.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const alive = dependencies.processGroupAlive ?? processGroupAlive;
  const signal = dependencies.signalOwnedGroup ?? signalOwnedGroup;
  const gracefulMs = dependencies.gracefulMs ?? DEFAULT_GRACEFUL_MS;
  const terminateMs = dependencies.terminateMs ?? DEFAULT_TERMINATE_MS;
  const killMs = dependencies.killMs ?? DEFAULT_KILL_MS;
  for (const [name, value] of Object.entries({ gracefulMs, terminateMs, killMs })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }

  const ownedGroupAlive = (child: CodexAppServerChild) => {
    const pid = child.pid;
    return Boolean(pid && pid > 1 && alive(pid));
  };

  const stopped = (child: CodexAppServerChild) =>
    observedClosed.has(child) && !ownedGroupAlive(child);

  const waitUntilStopped = async (
    child: CodexAppServerChild,
    timeoutMs: number,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    do {
      if (stopped(child)) return true;
      await wait(Math.min(20, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return stopped(child);
  };

  const shutdownChild = (child: CodexAppServerChild): Promise<void> => {
    const prior = releases.get(child);
    if (prior) return prior;
    const operation = (async () => {
      child.stdin.end();
      if (await waitUntilStopped(child, gracefulMs)) return;
      if (ownedGroupAlive(child) || !observedClosed.has(child)) {
        signal(child, "SIGTERM");
      }
      if (await waitUntilStopped(child, terminateMs)) return;
      signal(child, "SIGKILL");
      if (!(await waitUntilStopped(child, killMs))) {
        throw containmentError(
          "CODEX_TERMINATION_TIMEOUT",
          "Codex owned process group did not terminate",
        );
      }
    })().then(() => {
      children.delete(child);
    });
    releases.set(child, operation);
    return operation;
  };

  const containment = Object.freeze<CodexAppServerContainment>({
    workRoot() {
      if (closed) {
        throw containmentError(
          "CODEX_CONTAINMENT_CLOSED",
          "Codex app-server containment is closed",
        );
      }
      return boundary.cwd;
    },
    spawn(args) {
      if (closed) {
        throw containmentError("CODEX_CONTAINMENT_CLOSED", "Codex app-server containment is closed");
      }
      if (
        args.length !== CODEX_APP_SERVER_ARGS.length ||
        args.some((value, index) => value !== CODEX_APP_SERVER_ARGS[index])
      ) {
        throw containmentError(
          "CODEX_CONTAINMENT_ARGUMENTS_DENIED",
          "Only the fixed Codex app-server stdio invocation is allowed",
        );
      }
      if (
        boundary.proxy !== resolved.proxyIdentity ||
        boundary.proxy.isClosed() ||
        boundary.proxy.port !== resolved.proxyPort ||
        boundary.proxy.url !== resolved.proxyUrl ||
        boundary.proxy.policySha256 !== resolved.proxyPolicySha256 ||
        proxyPolicyHash(
          boundary.proxy.allowedHosts,
          boundary.proxy.allowedPorts,
        ) !== resolved.proxyPolicySha256 ||
        boundary.proxy.url !== `http://127.0.0.1:${boundary.proxy.port}`
      ) {
        throw containmentError(
          "CODEX_PROXY_MISMATCH",
          "Captured Codex app-server proxy is unavailable",
        );
      }
      verifyCodexSandboxProfileIdentity(
        boundary.sandboxProfilePath,
        profileIdentity,
      );
      const child = spawnProcess(
        "/usr/bin/sandbox-exec",
        [
          ...codexSandboxMetadataPathArguments([
            boundary.codexHome,
            boundary.cwd,
          ]),
          "-D", `CODEX_HOME=${boundary.codexHome}`,
          "-D", `CODEX_CWD=${boundary.cwd}`,
          "-D", `CODEX_SCHEMA=${boundary.phaseSchemaPaths.planner}`,
          "-D", `CODEX_EXECUTABLE=${resolved.installation.executablePath}`,
          "-D", `CODEX_PROXY_ENDPOINT=localhost:${boundary.proxy.port}`,
          "-f", boundary.sandboxProfilePath,
          resolved.installation.executablePath,
          ...CODEX_APP_SERVER_ARGS,
        ],
        {
          cwd: boundary.cwd,
          detached: true,
          env: {
            CODEX_HOME: boundary.codexHome,
            HOME: boundary.codexHome,
            LANG: "C.UTF-8",
            LC_ALL: "C.UTF-8",
            NO_COLOR: "1",
            PATH: "/usr/bin:/bin",
            TMPDIR: boundary.codexHome,
            HTTPS_PROXY: boundary.proxy.url,
            HTTP_PROXY: boundary.proxy.url,
          },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      children.add(child);
      ownedChildren.add(child);
      child.once("close", () => {
        observedClosed.add(child);
      });
      return child;
    },
    async release(child) {
      if (!ownedChildren.has(child)) {
        throw containmentError(
          "CODEX_CONTAINMENT_CHILD_REQUIRED",
          "Codex app-server generation is not owned by this containment",
        );
      }
      if (!children.has(child) && observedClosed.has(child)) return;
      await shutdownChild(child);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.all([...children].map((child) => shutdownChild(child)));
      })();
      return closePromise;
    },
  });
  OWNED_CONTAINMENTS.add(containment);
  return containment;
}

const OWNED_CONTAINMENTS = new WeakSet<object>();

export function requireCodexAppServerContainment(
  value: unknown,
): CodexAppServerContainment {
  if (
    typeof value !== "object" ||
    value === null ||
    !OWNED_CONTAINMENTS.has(value)
  ) {
    throw containmentError(
      "CODEX_CONTAINMENT_AUTHORITY_REQUIRED",
      "Application-owned Codex app-server containment is required",
    );
  }
  return value as CodexAppServerContainment;
}
