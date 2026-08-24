import { spawn as nodeSpawn } from "node:child_process";
import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import {
  makeFunctionReference,
  type FunctionReference,
  type UserIdentity,
} from "convex/server";

import { startLocalAuthIssuer } from "../src/main/auth/issuer";
import {
  LOCAL_JWT_AUDIENCE,
  LOCAL_JWT_SUBJECT,
} from "../src/main/auth/jwt";
import {
  createColdBackup,
  restoreVerifiedBackup,
  type ColdBackup,
} from "../src/main/convex/backup";
import { deriveAdminCredential } from "../src/main/convex/bootstrap";
import {
  spawnBackend,
  type OwnedBackendProcess,
} from "../src/main/convex/process-driver";

const TEST_AUTH_PORT = 3412;
const LOCK_PATH = join(tmpdir(), "qali-task6-real-convex.lock");
const START_TIMEOUT_MS = 30_000;
const USER_ID = "qali-local-user";

type FunctionClient = Readonly<{
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
}>;

class MemoryKeychain {
  readonly values: Map<string, string>;

  constructor(values?: ReadonlyMap<string, string>) {
    this.values = new Map(values);
  }

  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireFixtureLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(LOCK_PATH, { mode: 0o700 });
      await writeFile(join(LOCK_PATH, "owner"), String(process.pid), {
        mode: 0o600,
      });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(LOCK_PATH, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(await readFile(join(LOCK_PATH, "owner"), "utf8"));
        if (Number.isSafeInteger(owner) && owner > 1 && !(await processExists(owner))) {
          await rm(LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Another fixture may still be writing the ownership marker.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  throw new Error("Timed out waiting for the disposable Convex integration lock");
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Could not reserve a loopback test port"));
        return;
      }
      resolvePromise(address.port);
    });
  });
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

async function waitForBackend(url: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
    } catch {
      // The pinned backend is still opening its disposable SQLite state.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Pinned Convex backend did not become ready");
}

async function deployTestProject(args: {
  deploymentUrl: string;
  adminCredential: string;
  cliEntryPath: string;
  backendProjectDirectory: string;
  processLogs: string[];
}): Promise<void> {
  const child = nodeSpawn(
    process.execPath,
    [
      args.cliEntryPath,
      "deploy",
      "--typecheck",
      "disable",
      "--codegen",
      "enable",
    ],
    {
      cwd: args.backendProjectDirectory,
      detached: true,
      env: {
        CONVEX_SELF_HOSTED_ADMIN_KEY: args.adminCredential,
        CONVEX_SELF_HOSTED_URL: args.deploymentUrl,
        CI: "1",
        ELECTRON_RUN_AS_NODE: "1",
        LANG: "C.UTF-8",
        NODE_PATH: resolve(import.meta.dir, "../../../node_modules"),
        PATH: "/usr/bin:/bin",
        QALI_LOCAL_AUTH_CHANNEL: "test",
        // The pre-desktop hosted backend still imports legacy Google env
        // declarations. The real test deployment has no cloud credentials by
        // design; Task 15 removes those unreachable imports from the package.
        SKIP_ENV_VALIDATION: "1",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collect = (source: "stdout" | "stderr", chunk: Buffer | string) => {
    const text = String(chunk).replaceAll(args.adminCredential, "<redacted>");
    args.processLogs.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `${source}: ${line}`));
  };
  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      if (child.pid && child.pid > 1) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The captured test deployment child may already have exited.
        }
      }
      rejectPromise(new Error("Convex test deployment timed out"));
    }, 120_000);
    child.once("error", () => {
      clearTimeout(timeout);
      rejectPromise(new Error("Convex test deployment could not start"));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error("Convex test deployment failed"));
    });
  });
}

async function setTestEnvironmentByAdmin(
  deploymentUrl: string,
  adminCredential: string,
): Promise<void> {
  const response = await fetch(`${deploymentUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${adminCredential}`,
      "Content-Type": "application/json",
      "Convex-Client": "qali-task6-integration",
    },
    body: JSON.stringify({
      changes: [
        { name: "SKIP_ENV_VALIDATION", value: "1" },
        { name: "QALI_LOCAL_AUTH_CHANNEL", value: "test" },
      ],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error("Could not configure the disposable Convex test environment");
  }
}

function functionReference(
  name: string,
  kind: "query" | "mutation",
): FunctionReference<typeof kind> {
  return makeFunctionReference(name) as FunctionReference<typeof kind>;
}

function tokenClient(deploymentUrl: string, token: string): FunctionClient {
  const client = new ConvexHttpClient(deploymentUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
  client.setAuth(token);
  return {
    query: (name, args) => client.query(functionReference(name, "query"), args),
    mutation: (name, args) =>
      client.mutation(functionReference(name, "mutation"), args),
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signedToken(
  privateKeyPem: string,
  kid: string,
  claims: Record<string, unknown>,
): string {
  const header = encode({ alg: "RS256", kid, typ: "JWT" });
  const payload = encode(claims);
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), createPrivateKey(privateKeyPem)).toString("base64url")}`;
}

type FixtureSnapshot = Readonly<{
  backup: ColdBackup;
  sourceRoot: string;
  instanceName: string;
  instanceSecret: string;
  adminCredential: string;
  keychainValues: ReadonlyMap<string, string>;
  buildMarker: string;
}>;

export type RepresentativeIds = Readonly<{ threadId: string }>;

export type PinnedConvexFixture = Readonly<{
  root: string;
  renderer: FunctionClient;
  broker: FunctionClient;
  client(token: string): FunctionClient;
  freshRendererToken(): Promise<string>;
  invalidTokens(
    kinds: readonly ("wrong-key" | "wrong-issuer" | "wrong-audience" | "expired")[],
  ): Promise<string[]>;
  seedRepresentativeRows(): Promise<RepresentativeIds>;
  readRepresentativeRows(ids: RepresentativeIds): Promise<{
    calendarRows: number;
    eventRows: number;
    pendingOperationRows: number;
    assistantMessageRows: number;
    buildMarker: string;
    settingsRevision: number;
  }>;
  stopAndCreateColdBackup(buildMarker: string): Promise<FixtureSnapshot>;
  dispose(): Promise<void>;
}>;

type StartOptions = Readonly<{
  root?: string;
  keychain?: MemoryKeychain;
  instanceName?: string;
  instanceSecret?: string;
  adminCredential?: string;
  deploy?: boolean;
  buildMarker?: string;
  restoredBackupId?: string;
}>;

async function readRestoredBuildMarker(
  backups: string,
  backupId: string,
): Promise<string> {
  const value = JSON.parse(
    await readFile(join(backups, backupId, "backup-manifest.json"), "utf8"),
  ) as { buildMarker?: unknown };
  if (
    typeof value.buildMarker !== "string" ||
    value.buildMarker.length === 0 ||
    Buffer.byteLength(value.buildMarker, "utf8") > 512
  ) {
    throw new Error("Restored backup build marker is invalid");
  }
  return value.buildMarker;
}

async function createFixture(options: StartOptions = {}): Promise<PinnedConvexFixture> {
  const releaseLock = await acquireFixtureLock();
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "qali-test-convex-")));
  if (!root.startsWith(tmpdir())) {
    await releaseLock();
    throw new Error("Real Convex fixtures must use a disposable test root");
  }
  const database = join(root, "database");
  const config = join(root, "config");
  const backups = join(root, "backups");
  await Promise.all([
    mkdir(database, { recursive: true, mode: 0o700 }),
    mkdir(config, { recursive: true, mode: 0o700 }),
    mkdir(backups, { recursive: true, mode: 0o700 }),
  ]);
  const settingsPath = join(config, "settings.json");
  try {
    await writeFile(settingsPath, '{"schemaVersion":2,"revision":41}\n', {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const keychain = options.keychain ?? new MemoryKeychain();
  const authIssuer = await startLocalAuthIssuer({
    hostname: "127.0.0.1",
    port: TEST_AUTH_PORT,
    keychain,
  });
  const deploymentPort = await freeLoopbackPort();
  const sitePort = await freeLoopbackPort();
  const deploymentUrl = `http://127.0.0.1:${deploymentPort}`;
  const siteUrl = `http://127.0.0.1:${sitePort}`;
  const instanceName = options.instanceName ?? `qali-task6-${randomBytes(6).toString("hex")}`;
  const instanceSecret = options.instanceSecret ?? randomBytes(32).toString("hex");
  const resources = resolve(import.meta.dir, "../resources");
  const adminCredential =
    options.adminCredential ??
    (await deriveAdminCredential(
      keychain,
      join(resources, "bin/convex-generate-key"),
      instanceName,
      instanceSecret,
      nodeSpawn,
    ));

  let backend: OwnedBackendProcess | null = null;
  const processLogs: string[] = [];
  let stopped = false;
  let lockReleased = false;
  let buildMarker = options.buildMarker ?? "deployed-task-6";
  const release = async () => {
    if (lockReleased) return;
    lockReleased = true;
    await releaseLock();
  };
  try {
    backend = await spawnBackend(
      {
        backendExecutable: join(resources, "bin/convex-local-backend"),
        databaseDirectory: database,
        deploymentUrl,
        siteUrl,
        instanceName,
        instanceSecret,
      },
      (entry) => processLogs.push(`${entry.source}: ${entry.message}`),
    );
    await waitForBackend(deploymentUrl);
    if (options.deploy !== false) {
      await setTestEnvironmentByAdmin(deploymentUrl, adminCredential);
      await deployTestProject({
        deploymentUrl,
        adminCredential,
        cliEntryPath: join(resources, "convex-cli/cli.bundle.cjs"),
        backendProjectDirectory: resolve(import.meta.dir, "../../../packages/backend"),
        processLogs,
      });
    }
  } catch (error) {
    await backend?.stop();
    await authIssuer.close();
    await release();
    if (options.root === undefined) {
      await rm(root, { recursive: true, force: true });
    }
    throw new Error(
      `${error instanceof Error ? error.message : "Pinned Convex fixture failed"}\n${processLogs.slice(-30).join("\n")}`,
      { cause: error },
    );
  }

  const renderer = tokenClient(
    deploymentUrl,
    await authIssuer.authority.mintRendererToken(),
  );
  const broker = tokenClient(
    deploymentUrl,
    await authIssuer.authority.mintDesktopBrokerToken(),
  );
  const admin = new ConvexHttpClient(deploymentUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
  admin.setAdminAuth(adminCredential);

  const stopRuntime = async () => {
    if (stopped) return;
    stopped = true;
    await backend?.stop();
    backend = null;
    await authIssuer.close();
    await release();
  };

  const fixture: PinnedConvexFixture = {
    root,
    renderer,
    broker,
    client: (token) => tokenClient(deploymentUrl, token),
    freshRendererToken: async () =>
      await authIssuer.authority.mintRendererToken(),
    async invalidTokens(kinds) {
      const stored = JSON.parse(
        keychain.values.get("local-jwt-signing-key") ?? "{}",
      ) as { kid?: string; privateKeyPem?: string };
      if (!stored.kid || !stored.privateKeyPem) {
        throw new Error("JWT test signing key was not created");
      }
      const now = Math.floor(Date.now() / 1_000);
      const baseClaims = {
        iss: authIssuer.issuer,
        aud: LOCAL_JWT_AUDIENCE,
        sub: LOCAL_JWT_SUBJECT,
        role: "renderer",
        email: "local@qali.app",
        name: "Qali User",
        iat: now,
        exp: now + 120,
      };
      return kinds.map((kind) => {
        if (kind === "wrong-key") {
          const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
          const wrongPem = pair.privateKey
            .export({ format: "pem", type: "pkcs8" })
            .toString();
          return signedToken(wrongPem, stored.kid!, baseClaims);
        }
        const claims = {
          ...baseClaims,
          ...(kind === "wrong-issuer"
            ? { iss: "http://127.0.0.1:65535" }
            : {}),
          ...(kind === "wrong-audience" ? { aud: "another-app" } : {}),
          ...(kind === "expired" ? { iat: now - 300, exp: now - 120 } : {}),
        };
        return signedToken(stored.privateKeyPem!, stored.kid!, claims);
      });
    },
    async seedRepresentativeRows() {
      const now = Date.now();
      const remoteSnapshot = {
        localEventId: "local_event_backup_001",
        accountId: "account_backup_001",
        calendarId: "primary",
        remoteEventId: "remote-backup-1",
        summary: "Remote baseline",
        startMs: now + 60 * 60_000,
        endMs: now + 2 * 60 * 60_000,
        allDay: false,
        status: "confirmed",
      };
      try {
        await broker.mutation("desktopCalendar:completeRemoteSync", {
          accountId: remoteSnapshot.accountId,
          calendarId: remoteSnapshot.calendarId,
          syncToken: "sync-backup-1",
        });
        await broker.mutation("desktopCalendar:applyRemotePage", {
          accountId: remoteSnapshot.accountId,
          calendarId: remoteSnapshot.calendarId,
          events: [
            {
              remoteSnapshot,
              remoteEtag: "etag-backup-1",
              remoteUpdatedAt: now,
            },
          ],
        });
        await admin.mutation(
          makeFunctionReference("desktopCalendar:enqueueOperation"),
          {
            userId: USER_ID,
            operationId: "operation_backup_001",
            accountId: remoteSnapshot.accountId,
            calendarId: remoteSnapshot.calendarId,
            localEventId: remoteSnapshot.localEventId,
            remoteEventId: remoteSnapshot.remoteEventId,
            kind: "update",
            payload: { patch: { summary: "Pending local intent" } },
            baseRemoteSnapshot: remoteSnapshot,
            baseRemoteEtag: "etag-backup-1",
          },
        );
        const turn = (await broker.mutation("desktopAssistant:beginAttempt", {
          attemptId: "attempt_backup_001",
          text: "Show my calendar",
          timeZone: "UTC",
          nowMs: now,
        })) as { conversationId: string };
        return { threadId: turn.conversationId };
      } catch (error) {
        throw new Error(
          `Representative state seed failed\n${processLogs.slice(-30).join("\n")}`,
          { cause: error },
        );
      }
    },
    async readRepresentativeRows(ids) {
      const [calendars, events, leased, messages] = await Promise.all([
        renderer.query("calendar:listCalendars", {}) as Promise<unknown[]>,
        renderer.query("calendar:listEvents", {}) as Promise<unknown[]>,
        broker.mutation("desktopCalendar:leaseOperations", {
          accountId: "account_backup_001",
          leaseId: "lease_backup_001",
          limit: 5,
          leaseDurationMs: 30_000,
        }) as Promise<unknown[]>,
        renderer.query("assistantData:listMessages", {
          threadId: ids.threadId,
        }) as Promise<unknown[]>,
      ]);
      await Promise.all([
        readFile(join(database, "modules/representative.bundle"), "utf8"),
        readFile(join(database, "storage/representative.blob"), "utf8"),
      ]);
      return {
        calendarRows: calendars.length,
        eventRows: events.length,
        pendingOperationRows: leased.length,
        assistantMessageRows: messages.length,
        buildMarker: options.restoredBackupId
          ? await readRestoredBuildMarker(backups, options.restoredBackupId)
          : buildMarker,
        settingsRevision: (JSON.parse(await readFile(settingsPath, "utf8")) as {
          revision: number;
        }).revision,
      };
    },
    async stopAndCreateColdBackup(marker) {
      buildMarker = marker;
      await stopRuntime();
      await Promise.all([
        mkdir(join(database, "modules"), { recursive: true, mode: 0o700 }),
        mkdir(join(database, "storage"), { recursive: true, mode: 0o700 }),
      ]);
      await Promise.all([
        writeFile(join(database, "modules/representative.bundle"), "module-state", {
          mode: 0o600,
        }),
        writeFile(join(database, "storage/representative.blob"), "storage-state", {
          mode: 0o600,
        }),
      ]);
      const backup = await createColdBackup(
        { root, database, config, backups },
        marker,
      );
      return {
        backup,
        sourceRoot: root,
        instanceName,
        instanceSecret,
        adminCredential,
        keychainValues: new Map(keychain.values),
        buildMarker: marker,
      };
    },
    async dispose() {
      await stopRuntime();
      await rm(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

export async function startAuthenticatedPinnedConvex(): Promise<PinnedConvexFixture> {
  return await createFixture();
}

export async function restorePinnedConvexBackup(
  snapshot: FixtureSnapshot,
): Promise<PinnedConvexFixture> {
  const root = await mkdtemp(join(tmpdir(), "qali-test-convex-restored-"));
  const database = join(root, "database");
  const config = join(root, "config");
  const backups = join(root, "backups");
  await Promise.all([
    mkdir(database, { recursive: true, mode: 0o700 }),
    mkdir(config, { recursive: true, mode: 0o700 }),
    mkdir(backups, { recursive: true, mode: 0o700 }),
  ]);
  const copiedBackup = join(backups, snapshot.backup.id);
  await mkdir(dirname(copiedBackup), { recursive: true, mode: 0o700 });
  await cp(snapshot.backup.path, copiedBackup, { recursive: true });
  await restoreVerifiedBackup(snapshot.backup.id, { root, database, config, backups });
  return await createFixture({
    root,
    keychain: new MemoryKeychain(snapshot.keychainValues),
    instanceName: snapshot.instanceName,
    instanceSecret: snapshot.instanceSecret,
    adminCredential: snapshot.adminCredential,
    deploy: false,
    restoredBackupId: snapshot.backup.id,
  });
}
