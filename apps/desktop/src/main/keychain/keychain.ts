import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  IDENTITIES,
  type AppIdentity,
  type KeychainService,
} from "../identity";
import { observeOwnedSpawn } from "../processes/owned-spawn-observer";

export const QALI_KEYCHAIN_RECORDS = [
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

export type QaliKeychainRecord = (typeof QALI_KEYCHAIN_RECORDS)[number];

type KeychainRequest =
  | {
      operation: "get" | "delete";
      service: KeychainService;
      account: QaliKeychainRecord;
    }
  | {
      operation: "set";
      service: KeychainService;
      account: QaliKeychainRecord;
      value: string;
    };

type SpawnOptions = {
  env: Record<string, string>;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
};

export type KeychainSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type KeychainRuntime = Readonly<{
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  timeoutMs?: number;
}>;

export type KeychainUnavailableCode =
  "invalid-runtime" | "unavailable" | "timeout" | "protocol";

export class KeychainUnavailableError extends Error {
  readonly recoverable = true;

  constructor(
    readonly code: KeychainUnavailableCode,
    message = "Keychain is unavailable",
  ) {
    super(message);
    this.name = "KeychainUnavailableError";
  }
}

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

function isContainedBy(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return (
    childRelativePath === "" ||
    (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
  );
}

export function resolveKeychainHelperPath(runtime: KeychainRuntime): string {
  const configuredRoot = runtime.isPackaged
    ? runtime.resourcesPath
    : resolve(runtime.appPath, "resources");

  let root: string;
  let helper: string;
  try {
    root = realpathSync.native(configuredRoot);
    const candidate = join(root, "bin", "keychain-helper");
    const candidateMetadata = lstatSync(candidate);
    if (candidateMetadata.isSymbolicLink() || !candidateMetadata.isFile()) {
      throw new Error("unexpected helper target");
    }
    if ((candidateMetadata.mode & 0o111) === 0) {
      throw new Error("helper is not executable");
    }
    helper = realpathSync.native(candidate);
  } catch {
    throw new KeychainUnavailableError(
      "invalid-runtime",
      "Keychain helper must be a regular bundled executable",
    );
  }

  if (!isContainedBy(root, helper)) {
    throw new KeychainUnavailableError(
      "invalid-runtime",
      "Keychain helper resolves outside its owned resource root",
    );
  }
  if (runtime.isPackaged) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(root, "packaged-resource-manifest.json"), "utf8"),
      ) as {
        entries?: Array<{
          bytes?: unknown;
          mode?: unknown;
          path?: unknown;
          sha256?: unknown;
        }>;
        formatVersion?: unknown;
      };
      const matches = (manifest.entries ?? []).filter(
        (entry) => entry.path === "bin/keychain-helper",
      );
      const proof = matches[0];
      const metadata = lstatSync(helper);
      const bytes = readFileSync(helper);
      if (
        manifest.formatVersion !== 2 ||
        matches.length !== 1 ||
        !proof ||
        proof.bytes !== bytes.byteLength ||
        proof.mode !== (metadata.mode & 0o777) ||
        typeof proof.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(proof.sha256) ||
        createHash("sha256").update(bytes).digest("hex") !== proof.sha256
      ) {
        throw new Error("invalid proof");
      }
    } catch {
      throw new KeychainUnavailableError(
        "invalid-runtime",
        "Keychain helper failed packaged resource verification",
      );
    }
  }
  return helper;
}

function validateIdentity(identity: AppIdentity): KeychainService {
  const fixedIdentity = IDENTITIES[identity.channel];
  if (
    !Object.isFrozen(identity) ||
    identity.bundleId !== fixedIdentity.bundleId ||
    identity.name !== fixedIdentity.name ||
    identity.namespace !== fixedIdentity.namespace
  ) {
    throw new KeychainUnavailableError(
      "invalid-runtime",
      "Keychain requires an immutable Qali application identity",
    );
  }
  return fixedIdentity.bundleId;
}

function resolveTimeout(runtime: KeychainRuntime): number {
  const timeout = runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new KeychainUnavailableError(
      "invalid-runtime",
      "Invalid Keychain helper timeout",
    );
  }
  return timeout;
}

function invalidResponse(): KeychainUnavailableError {
  return new KeychainUnavailableError(
    "protocol",
    "Invalid Keychain helper response",
  );
}

function parseResponse(output: string): { ok: true; value?: string | null } {
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) throw invalidResponse();

  let response: unknown;
  try {
    response = JSON.parse(lines[0] ?? "");
  } catch {
    throw invalidResponse();
  }

  if (!response || typeof response !== "object" || !("ok" in response)) {
    throw invalidResponse();
  }
  if (response.ok === false) {
    throw new KeychainUnavailableError("unavailable");
  }
  if (response.ok !== true) throw invalidResponse();

  const value = "value" in response ? response.value : undefined;
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw invalidResponse();
  }
  return { ok: true, value };
}

export class KeychainStore {
  readonly #helperPath: string;
  readonly #service: KeychainService;
  readonly #spawn: KeychainSpawn;
  readonly #timeoutMs: number;

  constructor(
    identity: AppIdentity,
    runtime: KeychainRuntime,
    spawnProcess: KeychainSpawn = nodeSpawn,
  ) {
    this.#service = validateIdentity(identity);
    this.#helperPath = resolveKeychainHelperPath(runtime);
    this.#timeoutMs = resolveTimeout(runtime);
    this.#spawn = spawnProcess;
  }

  async get(account: QaliKeychainRecord): Promise<string | null> {
    const response = await this.#execute({
      operation: "get",
      service: this.#service,
      account,
    });
    return response.value ?? null;
  }

  async set(account: QaliKeychainRecord, value: string): Promise<void> {
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new KeychainUnavailableError(
        "protocol",
        "Keychain value exceeds the maximum size",
      );
    }
    await this.#execute({
      operation: "set",
      service: this.#service,
      account,
      value,
    });
  }

  async delete(account: QaliKeychainRecord): Promise<void> {
    await this.#execute({
      operation: "delete",
      service: this.#service,
      account,
    });
  }

  async #execute(
    request: KeychainRequest,
  ): Promise<{ ok: true; value?: string | null }> {
    const input = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(input, "utf8") > MAX_REQUEST_BYTES) {
      throw new KeychainUnavailableError(
        "protocol",
        "Keychain request exceeds the maximum size",
      );
    }

    return await new Promise((resolvePromise, rejectPromise) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        observeOwnedSpawn("keychain-helper", this.#helperPath, [], {
          LANG: "C.UTF-8",
          PATH: "/usr/bin:/bin",
        });
        child = this.#spawn(this.#helperPath, [], {
          env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        rejectPromise(new KeychainUnavailableError("unavailable"));
        return;
      }

      let stdout = Buffer.alloc(0);
      let stderrBytes = 0;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.stdin.removeListener("error", onStdinError);
        child.removeListener("error", onChildError);
        child.removeListener("close", onClose);
      };
      const terminate = () => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          // The helper may already have exited between the state check and kill.
        }
      };
      const fail = (
        error: KeychainUnavailableError,
        terminateChild = false,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminateChild) terminate();
        rejectPromise(error);
      };
      const succeed = (response: { ok: true; value?: string | null }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise(response);
      };
      const onStdout = (chunk: Buffer | string) => {
        if (settled) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdout = Buffer.concat([stdout, data]);
        if (stdout.byteLength > MAX_RESPONSE_BYTES) {
          fail(
            new KeychainUnavailableError(
              "protocol",
              "Keychain helper response exceeds the maximum size",
            ),
            true,
          );
        }
      };
      const onStderr = (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_RESPONSE_BYTES) {
          fail(new KeychainUnavailableError("protocol"), true);
        }
      };
      const onStdinError = () => {
        fail(new KeychainUnavailableError("unavailable"), true);
      };
      const onChildError = () => {
        fail(new KeychainUnavailableError("unavailable"), true);
      };
      const onClose = (code: number | null) => {
        if (settled) return;
        if (code !== 0) {
          fail(new KeychainUnavailableError("unavailable"));
          return;
        }
        try {
          succeed(parseResponse(stdout.toString("utf8")));
        } catch (error) {
          fail(
            error instanceof KeychainUnavailableError
              ? error
              : invalidResponse(),
          );
        }
      };

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.stdin.once("error", onStdinError);
      child.once("error", onChildError);
      child.once("close", onClose);
      timeout = setTimeout(() => {
        fail(new KeychainUnavailableError("timeout"), true);
      }, this.#timeoutMs);

      try {
        child.stdin.end(input);
      } catch {
        fail(new KeychainUnavailableError("unavailable"), true);
      }
    });
  }
}
