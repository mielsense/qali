import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import {
  removeStagedBackupManifest,
  stageVerifiedBackup,
  verifyBackup,
  verifyStagedBackup,
  type BackupPaths,
} from "../convex/backup";

const BACKUP_ID = /^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/;
const NAMESPACE = /^[A-Za-z][A-Za-z0-9 ._-]{0,63}$/;
const MANIFEST_FILE = "backup-manifest.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const RESTORE_CHECKPOINT = ".restore-pending.json";
const DISPLACED_DATABASE = /^\.database-displaced-[0-9a-f-]{36}$/;
const STAGED_DATABASE = /^\.database-restore-[0-9a-f-]{36}$/;
const DISPLACED_SETTINGS = /^\.settings-displaced-[0-9a-f-]{36}\.json$/;
const STAGED_SETTINGS = /^\.settings-restore-[0-9a-f-]{36}$/;
const RESTORE_PHASES_V1 = [
  "prepared",
  "displaced",
  "activated",
  "verified",
] as const;
const RESTORE_PHASES_V2 = [
  "verified",
  "database-displaced",
  "settings-displaced",
  "database-activated",
  "settings-activated",
  "runtime-healthy",
  "finalized",
] as const;

type RestorePhaseV1 = (typeof RESTORE_PHASES_V1)[number];
type RestorePhaseV2 = (typeof RESTORE_PHASES_V2)[number];
type RestoreCheckpointV1 = Readonly<{
  version: 1;
  phase: RestorePhaseV1;
  backupId: string;
  buildMarker: string;
  staging: string;
  displaced: string;
}>;
type RestoreCheckpointV2 = Readonly<{
  version: 2;
  phase: RestorePhaseV2;
  backupId: string;
  buildMarker: string;
  databaseStaging: string;
  settingsStaging: string;
  databaseDisplaced: string;
  settingsDisplaced: string;
  settingsPreviouslyExisted: boolean;
}>;
type RestoreCheckpoint = RestoreCheckpointV1 | RestoreCheckpointV2;

export type RecoveryAuthority = Readonly<{
  appData: string;
  namespace: string;
  root: string;
  database: string;
  config: string;
  backups: string;
}>;

export type RecoveryBackupSummary = Readonly<{
  id: string;
  createdAt: string;
  bytes: number;
  buildMarker: string;
  verified: true;
}>;

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function unsafeRoot(): never {
  throw new Error("UNSAFE_DATA_ROOT");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeRestoreCheckpoint(
  authority: RecoveryAuthority,
  checkpoint: RestoreCheckpoint,
): Promise<void> {
  const checkpointPath = join(authority.root, RESTORE_CHECKPOINT);
  const temporaryPath = join(
    authority.root,
    `${RESTORE_CHECKPOINT}.tmp-${randomUUID()}`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, checkpointPath);
    await syncDirectory(authority.root);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function removeCheckpoint(authority: RecoveryAuthority): Promise<void> {
  await rm(join(authority.root, RESTORE_CHECKPOINT));
  await syncDirectory(authority.root);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("RESTORE_CHECKPOINT_INVALID");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("RESTORE_CHECKPOINT_INVALID");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validCheckpointBase(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.backupId === "string" &&
    BACKUP_ID.test(candidate.backupId) &&
    typeof candidate.buildMarker === "string" &&
    candidate.buildMarker.length >= 1 &&
    candidate.buildMarker.length <= 512
  );
}

async function readRestoreCheckpoint(
  authority: RecoveryAuthority,
): Promise<RestoreCheckpoint | null> {
  let raw: string;
  try {
    raw = await readFile(join(authority.root, RESTORE_CHECKPOINT), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > 4_096) {
    throw new Error("RESTORE_CHECKPOINT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("RESTORE_CHECKPOINT_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("RESTORE_CHECKPOINT_INVALID");
  const candidate = value as Record<string, unknown>;
  if (!validCheckpointBase(candidate))
    throw new Error("RESTORE_CHECKPOINT_INVALID");
  if (candidate.version === 1) {
    if (
      !RESTORE_PHASES_V1.includes(candidate.phase as RestorePhaseV1) ||
      typeof candidate.staging !== "string" ||
      !STAGED_DATABASE.test(candidate.staging) ||
      typeof candidate.displaced !== "string" ||
      !DISPLACED_DATABASE.test(candidate.displaced)
    )
      throw new Error("RESTORE_CHECKPOINT_INVALID");
    return Object.freeze(candidate as unknown as RestoreCheckpointV1);
  }
  if (
    candidate.version !== 2 ||
    !RESTORE_PHASES_V2.includes(candidate.phase as RestorePhaseV2) ||
    typeof candidate.databaseStaging !== "string" ||
    !STAGED_DATABASE.test(candidate.databaseStaging) ||
    typeof candidate.settingsStaging !== "string" ||
    !STAGED_SETTINGS.test(candidate.settingsStaging) ||
    typeof candidate.databaseDisplaced !== "string" ||
    !DISPLACED_DATABASE.test(candidate.databaseDisplaced) ||
    typeof candidate.settingsDisplaced !== "string" ||
    !DISPLACED_SETTINGS.test(candidate.settingsDisplaced) ||
    typeof candidate.settingsPreviouslyExisted !== "boolean"
  )
    throw new Error("RESTORE_CHECKPOINT_INVALID");
  return Object.freeze(candidate as unknown as RestoreCheckpointV2);
}

async function exactDirectory(path: string): Promise<string> {
  const metadata = await lstat(path).catch(unsafeRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return unsafeRoot();
  return await realpath(path).catch(unsafeRoot);
}

async function exactDirectoryOrMissing(path: string): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return resolve(path);
    return unsafeRoot();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return unsafeRoot();
  return await realpath(path).catch(unsafeRoot);
}

/** Create the only authority accepted by recovery operations. */
export async function createRecoveryAuthority(
  input: Readonly<{
    appData: string;
    namespace: string;
    root: string;
    database: string;
    backups: string;
  }>,
): Promise<RecoveryAuthority> {
  if (
    !NAMESPACE.test(input.namespace) ||
    input.namespace === "." ||
    input.namespace === ".."
  ) {
    return unsafeRoot();
  }
  const appData = await exactDirectory(input.appData);
  const root = await exactDirectory(input.root);
  const expectedDatabase = resolve(root, "database");
  const expectedConfig = resolve(root, "config");
  if (resolve(input.root, "database") !== resolve(input.database)) {
    return unsafeRoot();
  }
  const database = await exactDirectoryOrMissing(expectedDatabase);
  const config = await exactDirectoryOrMissing(expectedConfig);
  const backups = await exactDirectory(input.backups);
  const home = await realpath(homedir()).catch(() => homedir());
  if (
    root === "/" ||
    root === home ||
    resolve(appData, input.namespace) !== root ||
    basename(root) !== input.namespace ||
    expectedDatabase !== database ||
    expectedConfig !== config ||
    resolve(root, "backups") !== backups ||
    !contained(appData, root) ||
    !contained(root, database) ||
    !contained(root, config) ||
    !contained(root, backups)
  ) {
    return unsafeRoot();
  }
  return Object.freeze({
    appData,
    namespace: input.namespace,
    root,
    database,
    config,
    backups,
  });
}

export async function listRecoveryBackups(
  authority: RecoveryAuthority,
): Promise<RecoveryBackupSummary[]> {
  const verified: RecoveryBackupSummary[] = [];
  for (const entry of await readdir(authority.backups, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory() || !BACKUP_ID.test(entry.name)) continue;
    const path = join(authority.backups, entry.name);
    if (!(await verifyBackup(path))) continue;
    try {
      const manifestPath = join(path, MANIFEST_FILE);
      const metadata = await lstat(manifestPath);
      if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) continue;
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        id?: unknown;
        createdAt?: unknown;
        buildMarker?: unknown;
        files?: Array<{ bytes?: unknown }>;
      };
      if (
        manifest.id !== entry.name ||
        typeof manifest.createdAt !== "string" ||
        !Number.isFinite(Date.parse(manifest.createdAt)) ||
        typeof manifest.buildMarker !== "string" ||
        manifest.buildMarker.length > 512 ||
        !Array.isArray(manifest.files)
      )
        continue;
      const bytes = manifest.files.reduce(
        (total, file) =>
          total +
          (Number.isSafeInteger(file.bytes) && (file.bytes as number) >= 0
            ? (file.bytes as number)
            : 0),
        0,
      );
      verified.push({
        id: entry.name,
        createdAt: manifest.createdAt,
        buildMarker: manifest.buildMarker,
        bytes,
        verified: true,
      });
    } catch {
      // Verification and parsing are deliberately fail-closed per candidate.
    }
  }
  return verified.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export type PreparedRestore = Readonly<{
  stagingPath: string;
  databaseStagingPath: string;
  settingsStagingPath: string | null;
  activate(verifyRestoredDatabase: () => Promise<void>): Promise<
    Readonly<{
      displacedPath: string;
      settingsDisplacedPath: string | null;
    }>
  >;
}>;

async function removeStagedCopies(
  databaseStagingPath: string,
  settingsStagingPath: string | null,
): Promise<void> {
  await Promise.all([
    rm(databaseStagingPath, { recursive: true, force: true }),
    ...(settingsStagingPath
      ? [rm(settingsStagingPath, { recursive: true, force: true })]
      : []),
  ]);
}

export async function prepareVerifiedRestore(
  input: Readonly<{
    authority: RecoveryAuthority;
    backupId: string;
    expectedBuildMarker: string;
  }>,
): Promise<PreparedRestore> {
  if (!BACKUP_ID.test(input.backupId)) throw new Error("INVALID_BACKUP_ID");
  if (await readRestoreCheckpoint(input.authority)) {
    throw new Error("RESTORE_RECOVERY_REQUIRED");
  }
  const paths: BackupPaths = input.authority;
  const staged = await stageVerifiedBackup(input.backupId, paths);
  if (staged.manifest.buildMarker !== input.expectedBuildMarker) {
    await removeStagedCopies(
      staged.databaseStagingPath,
      staged.settingsStagingPath,
    );
    throw new Error("BACKUP_BUILD_INCOMPATIBLE");
  }
  let consumed = false;
  return Object.freeze({
    stagingPath: staged.stagingPath,
    databaseStagingPath: staged.databaseStagingPath,
    settingsStagingPath: staged.settingsStagingPath,
    async activate(verifyRestoredDatabase) {
      if (consumed) throw new Error("RESTORE_PLAN_CONSUMED");
      consumed = true;
      if (
        !(await verifyStagedBackup(staged.databaseStagingPath, "database")) ||
        (staged.settingsStagingPath !== null &&
          !(await verifyStagedBackup(staged.settingsStagingPath, "settings")))
      ) {
        await removeStagedCopies(
          staged.databaseStagingPath,
          staged.settingsStagingPath,
        );
        throw new Error("Backup staged owner verification failed");
      }
      await removeStagedBackupManifest(staged.databaseStagingPath);
      if (staged.settingsStagingPath)
        await removeStagedBackupManifest(staged.settingsStagingPath);
      const displacedPath = join(
        input.authority.root,
        `.database-displaced-${randomUUID()}`,
      );
      const settingsDisplacedPath = staged.settingsStagingPath
        ? join(input.authority.root, `.settings-displaced-${randomUUID()}.json`)
        : null;
      let journaled = false;
      try {
        if (!staged.settingsStagingPath || !settingsDisplacedPath) {
          const checkpoint: RestoreCheckpointV1 = Object.freeze({
            version: 1,
            phase: "prepared",
            backupId: input.backupId,
            buildMarker: input.expectedBuildMarker,
            staging: basename(staged.databaseStagingPath),
            displaced: basename(displacedPath),
          });
          await writeRestoreCheckpoint(input.authority, checkpoint);
          journaled = true;
          await rename(input.authority.database, displacedPath);
          await syncDirectory(input.authority.root);
          await writeRestoreCheckpoint(input.authority, {
            ...checkpoint,
            phase: "displaced",
          });
          await rename(staged.databaseStagingPath, input.authority.database);
          await syncDirectory(input.authority.root);
          await writeRestoreCheckpoint(input.authority, {
            ...checkpoint,
            phase: "activated",
          });
          await verifyRestoredDatabase();
          await writeRestoreCheckpoint(input.authority, {
            ...checkpoint,
            phase: "verified",
          });
          return { displacedPath, settingsDisplacedPath: null };
        }

        const settingsTarget = join(input.authority.config, "settings.json");
        const settingsPreviouslyExisted =
          await regularFileExists(settingsTarget);
        const checkpoint: RestoreCheckpointV2 = Object.freeze({
          version: 2,
          phase: "verified",
          backupId: input.backupId,
          buildMarker: input.expectedBuildMarker,
          databaseStaging: basename(staged.databaseStagingPath),
          settingsStaging: basename(staged.settingsStagingPath),
          databaseDisplaced: basename(displacedPath),
          settingsDisplaced: basename(settingsDisplacedPath),
          settingsPreviouslyExisted,
        });
        await writeRestoreCheckpoint(input.authority, checkpoint);
        journaled = true;
        await rename(input.authority.database, displacedPath);
        await syncDirectory(input.authority.root);
        await writeRestoreCheckpoint(input.authority, {
          ...checkpoint,
          phase: "database-displaced",
        });
        if (settingsPreviouslyExisted) {
          await rename(settingsTarget, settingsDisplacedPath);
          await syncDirectory(input.authority.config);
        }
        await writeRestoreCheckpoint(input.authority, {
          ...checkpoint,
          phase: "settings-displaced",
        });
        await rename(staged.databaseStagingPath, input.authority.database);
        await syncDirectory(input.authority.root);
        await writeRestoreCheckpoint(input.authority, {
          ...checkpoint,
          phase: "database-activated",
        });
        await rename(
          join(staged.settingsStagingPath, "settings.json"),
          settingsTarget,
        );
        await rm(staged.settingsStagingPath, { recursive: true });
        await syncDirectory(input.authority.config);
        await syncDirectory(input.authority.root);
        await writeRestoreCheckpoint(input.authority, {
          ...checkpoint,
          phase: "settings-activated",
        });
        await verifyRestoredDatabase();
        await writeRestoreCheckpoint(input.authority, {
          ...checkpoint,
          phase: "runtime-healthy",
        });
        return {
          displacedPath,
          settingsDisplacedPath: settingsPreviouslyExisted
            ? settingsDisplacedPath
            : null,
        };
      } catch (error) {
        if (journaled) {
          try {
            await recoverInterruptedRestore(input.authority);
          } catch (rollbackError) {
            throw new Error("RESTORE_ROLLBACK_FAILED", {
              cause: rollbackError,
            });
          }
        } else {
          await removeStagedCopies(
            staged.databaseStagingPath,
            staged.settingsStagingPath,
          );
        }
        throw error;
      }
    },
  });
}

async function recoverV1Checkpoint(
  authority: RecoveryAuthority,
  checkpoint: RestoreCheckpointV1,
): Promise<
  Readonly<{ kind: "rolled-back" | "verified-pending" | "finalized" }>
> {
  const stagingPath = join(authority.root, checkpoint.staging);
  const displacedPath = join(authority.root, checkpoint.displaced);
  const [databaseExists, stagingExists, displacedExists] = await Promise.all([
    directoryExists(authority.database),
    directoryExists(stagingPath),
    directoryExists(displacedPath),
  ]);

  if (checkpoint.phase === "verified") {
    if (!databaseExists) {
      if (!displacedExists) throw new Error("RESTORE_ROLLBACK_UNAVAILABLE");
      await rename(displacedPath, authority.database);
      await syncDirectory(authority.root);
      if (stagingExists) {
        await rm(stagingPath, { recursive: true });
        await syncDirectory(authority.root);
      }
      await removeCheckpoint(authority);
      return { kind: "rolled-back" };
    }
    if (stagingExists) {
      await rm(stagingPath, { recursive: true });
      await syncDirectory(authority.root);
    }
    if (displacedExists) return { kind: "verified-pending" };
    await removeCheckpoint(authority);
    return { kind: "finalized" };
  }

  if (displacedExists) {
    if (databaseExists) {
      await rm(authority.database, { recursive: true });
      await syncDirectory(authority.root);
    }
    await rename(displacedPath, authority.database);
    await syncDirectory(authority.root);
  } else if (!databaseExists) {
    throw new Error("RESTORE_ROLLBACK_UNAVAILABLE");
  }
  if (stagingExists) {
    await rm(stagingPath, { recursive: true });
    await syncDirectory(authority.root);
  }
  await removeCheckpoint(authority);
  return { kind: "rolled-back" };
}

function v2CheckpointPaths(
  authority: RecoveryAuthority,
  checkpoint: RestoreCheckpointV2,
) {
  return {
    databaseStagingPath: join(authority.root, checkpoint.databaseStaging),
    settingsStagingPath: join(authority.root, checkpoint.settingsStaging),
    databaseDisplacedPath: join(authority.root, checkpoint.databaseDisplaced),
    settingsDisplacedPath: join(authority.root, checkpoint.settingsDisplaced),
    settingsTarget: join(authority.config, "settings.json"),
  } as const;
}

async function rollbackV2Checkpoint(
  authority: RecoveryAuthority,
  checkpoint: RestoreCheckpointV2,
): Promise<void> {
  const paths = v2CheckpointPaths(authority, checkpoint);
  const [
    databaseExists,
    databaseStagingExists,
    databaseDisplacedExists,
    settingsExists,
    settingsStagingExists,
    settingsDisplacedExists,
  ] = await Promise.all([
    directoryExists(authority.database),
    directoryExists(paths.databaseStagingPath),
    directoryExists(paths.databaseDisplacedPath),
    regularFileExists(paths.settingsTarget),
    directoryExists(paths.settingsStagingPath),
    regularFileExists(paths.settingsDisplacedPath),
  ]);
  const databaseWasDisplaced = checkpoint.phase !== "verified";
  const settingsWereDisplaced = !["verified", "database-displaced"].includes(
    checkpoint.phase,
  );
  if (!databaseExists && !databaseDisplacedExists)
    throw new Error("RESTORE_ROLLBACK_UNAVAILABLE");
  if (databaseWasDisplaced && !databaseDisplacedExists)
    throw new Error("RESTORE_ROLLBACK_UNAVAILABLE");
  if (
    checkpoint.settingsPreviouslyExisted &&
    ((!settingsExists && !settingsDisplacedExists) ||
      (settingsWereDisplaced && !settingsDisplacedExists))
  )
    throw new Error("RESTORE_ROLLBACK_UNAVAILABLE");

  if (databaseDisplacedExists) {
    if (databaseExists) await rm(authority.database, { recursive: true });
    await rename(paths.databaseDisplacedPath, authority.database);
    await syncDirectory(authority.root);
  }
  if (checkpoint.settingsPreviouslyExisted) {
    if (settingsDisplacedExists) {
      if (settingsExists) await rm(paths.settingsTarget);
      await rename(paths.settingsDisplacedPath, paths.settingsTarget);
      await syncDirectory(authority.config);
    }
  } else if (settingsExists) {
    await rm(paths.settingsTarget);
    await syncDirectory(authority.config);
  }
  if (databaseStagingExists)
    await rm(paths.databaseStagingPath, { recursive: true });
  if (settingsStagingExists)
    await rm(paths.settingsStagingPath, { recursive: true });
  await syncDirectory(authority.root);
  await removeCheckpoint(authority);
}

async function finishV2Finalization(
  authority: RecoveryAuthority,
  checkpoint: RestoreCheckpointV2,
): Promise<void> {
  const paths = v2CheckpointPaths(authority, checkpoint);
  await Promise.all([
    rm(paths.databaseDisplacedPath, { recursive: true, force: true }),
    rm(paths.settingsDisplacedPath, { force: true }),
    rm(paths.databaseStagingPath, { recursive: true, force: true }),
    rm(paths.settingsStagingPath, { recursive: true, force: true }),
  ]);
  await syncDirectory(authority.root);
  await syncDirectory(authority.config);
  await removeCheckpoint(authority);
}

export async function recoverInterruptedRestore(
  authority: RecoveryAuthority,
): Promise<
  Readonly<{ kind: "none" | "rolled-back" | "verified-pending" | "finalized" }>
> {
  const checkpoint = await readRestoreCheckpoint(authority);
  if (!checkpoint) {
    const staged: string[] = [];
    for (const entry of await readdir(authority.root, {
      withFileTypes: true,
    })) {
      if (
        !STAGED_DATABASE.test(entry.name) &&
        !STAGED_SETTINGS.test(entry.name)
      )
        continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("RESTORE_CHECKPOINT_INVALID");
      }
      staged.push(join(authority.root, entry.name));
    }
    if (!(await directoryExists(authority.database))) {
      throw new Error("RESTORE_ROLLBACK_UNAVAILABLE");
    }
    for (const path of staged) await rm(path, { recursive: true });
    if (staged.length > 0) await syncDirectory(authority.root);
    return { kind: staged.length > 0 ? "rolled-back" : "none" };
  }
  if (checkpoint.version === 1)
    return await recoverV1Checkpoint(authority, checkpoint);

  const paths = v2CheckpointPaths(authority, checkpoint);
  if (checkpoint.phase === "finalized") {
    if (
      !(await directoryExists(authority.database)) ||
      !(await regularFileExists(paths.settingsTarget))
    )
      throw new Error("RESTORE_VERIFIED_STORE_MISSING");
    await finishV2Finalization(authority, checkpoint);
    return { kind: "finalized" };
  }
  if (checkpoint.phase === "runtime-healthy") {
    const [databaseExists, settingsExists, displacedExists] = await Promise.all(
      [
        directoryExists(authority.database),
        regularFileExists(paths.settingsTarget),
        directoryExists(paths.databaseDisplacedPath),
      ],
    );
    if (databaseExists && settingsExists && displacedExists)
      return { kind: "verified-pending" };
  }
  await rollbackV2Checkpoint(authority, checkpoint);
  return { kind: "rolled-back" };
}

export async function rollbackPendingRestore(
  authority: RecoveryAuthority,
): Promise<void> {
  const checkpoint = await readRestoreCheckpoint(authority);
  if (!checkpoint) return;
  if (checkpoint.version === 2) {
    await rollbackV2Checkpoint(authority, checkpoint);
    return;
  }
  const stagingPath = join(authority.root, checkpoint.staging);
  const displacedPath = join(authority.root, checkpoint.displaced);
  const [databaseExists, stagingExists, displacedExists] = await Promise.all([
    directoryExists(authority.database),
    directoryExists(stagingPath),
    directoryExists(displacedPath),
  ]);
  if (!displacedExists) throw new Error("RESTORE_ROLLBACK_UNAVAILABLE");
  if (databaseExists) {
    await rm(authority.database, { recursive: true });
    await syncDirectory(authority.root);
  }
  await rename(displacedPath, authority.database);
  await syncDirectory(authority.root);
  if (stagingExists) {
    await rm(stagingPath, { recursive: true });
    await syncDirectory(authority.root);
  }
  await removeCheckpoint(authority);
}

export async function restoreLocalBackup(
  input: Readonly<{
    authority: RecoveryAuthority;
    backupId: string;
    expectedBuildMarker: string;
    verifyRestoredDatabase(): Promise<void>;
  }>,
): Promise<
  Readonly<{
    displacedPath: string;
    settingsDisplacedPath: string | null;
  }>
> {
  const prepared = await prepareVerifiedRestore(input);
  return await prepared.activate(input.verifyRestoredDatabase);
}

export async function finalizePendingRestore(
  authority: RecoveryAuthority,
): Promise<void> {
  const checkpoint = await readRestoreCheckpoint(authority);
  if (!checkpoint) return;
  if (
    (checkpoint.version === 1 && checkpoint.phase !== "verified") ||
    (checkpoint.version === 2 && checkpoint.phase !== "runtime-healthy")
  )
    throw new Error("RESTORE_NOT_VERIFIED");
  if (!(await directoryExists(authority.database))) {
    throw new Error("RESTORE_VERIFIED_STORE_MISSING");
  }
  if (checkpoint.version === 2) {
    const paths = v2CheckpointPaths(authority, checkpoint);
    if (!(await regularFileExists(paths.settingsTarget)))
      throw new Error("RESTORE_VERIFIED_STORE_MISSING");
    await writeRestoreCheckpoint(authority, {
      ...checkpoint,
      phase: "finalized",
    });
    await finishV2Finalization(authority, {
      ...checkpoint,
      phase: "finalized",
    });
    return;
  }
  const displacedPath = join(authority.root, checkpoint.displaced);
  if (await directoryExists(displacedPath)) {
    await rm(displacedPath, { recursive: true });
    await syncDirectory(authority.root);
  }
  await removeCheckpoint(authority);
}
