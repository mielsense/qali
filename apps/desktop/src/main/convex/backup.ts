import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type BackupPaths = Readonly<{
  root: string;
  database: string;
  /** Temporary compatibility: recovery v1 callers infer the canonical root/config path. */
  config?: string;
  backups: string;
}>;

export type BackupOwner = "database" | "settings";

export type BackupManifestFileV1 = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type BackupManifestFileV2 = Readonly<{
  owner: BackupOwner;
  path: string;
  bytes: number;
  sha256: string;
  mode: 0o600;
}>;

type BackupManifestBase = Readonly<{
  id: string;
  buildMarker: string;
  createdAt: string;
  complete: true;
}>;

export type BackupManifestV1 = BackupManifestBase &
  Readonly<{
    formatVersion: 1;
    files: BackupManifestFileV1[];
  }>;

export type BackupManifestV2 = BackupManifestBase &
  Readonly<{
    formatVersion: 2;
    owners: readonly [
      Readonly<{ owner: "database"; root: "database" }>,
      Readonly<{ owner: "settings"; root: "config" }>,
    ];
    files: BackupManifestFileV2[];
  }>;

export type BackupManifest = BackupManifestV1 | BackupManifestV2;

export type ColdBackup = Readonly<{
  id: string;
  path: string;
  manifest: BackupManifest;
}>;

export type StagedBackup = Readonly<{
  manifest: BackupManifest;
  /** Compatibility alias consumed by the v1 restore journal until its v2 task lands. */
  stagingPath: string;
  databaseStagingPath: string;
  settingsStagingPath: string | null;
}>;

const MANIFEST_FILE = "backup-manifest.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DATABASE_FILES = 10_000;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const BACKUP_ID = /^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const V2_OWNERS = Object.freeze([
  Object.freeze({ owner: "database" as const, root: "database" as const }),
  Object.freeze({ owner: "settings" as const, root: "config" as const }),
]) as BackupManifestV2["owners"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isContainedBy(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return (
    candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))
  );
}

function safeRelativePath(value: string): boolean {
  if (!value || isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== "..",
  );
}

function validBase(candidate: Record<string, unknown>): boolean {
  return (
    typeof candidate.id === "string" &&
    BACKUP_ID.test(candidate.id) &&
    typeof candidate.buildMarker === "string" &&
    candidate.buildMarker.length > 0 &&
    Buffer.byteLength(candidate.buildMarker, "utf8") <= 512 &&
    typeof candidate.createdAt === "string" &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    new Date(candidate.createdAt).toISOString() === candidate.createdAt &&
    candidate.complete === true
  );
}

function validFileCore(file: Record<string, unknown>): boolean {
  return (
    typeof file.path === "string" &&
    safeRelativePath(file.path) &&
    Number.isSafeInteger(file.bytes) &&
    (file.bytes as number) >= 0 &&
    (file.bytes as number) <= MAX_BACKUP_BYTES &&
    typeof file.sha256 === "string" &&
    SHA256.test(file.sha256)
  );
}

function validateTotalBytes(
  files: readonly Readonly<{ bytes: number }>[],
): boolean {
  let total = 0;
  for (const file of files) {
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > MAX_BACKUP_BYTES) return false;
  }
  return true;
}

function compareManifestFiles(
  left: BackupManifestFileV2,
  right: BackupManifestFileV2,
): number {
  const ownerDifference =
    (left.owner === "database" ? 0 : 1) - (right.owner === "database" ? 0 : 1);
  if (ownerDifference !== 0) return ownerDifference;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseBackupManifest(value: unknown): BackupManifest | null {
  if (!isRecord(value) || !validBase(value)) return null;

  if (value.formatVersion === 1) {
    if (
      !hasExactKeys(value, [
        "formatVersion",
        "id",
        "buildMarker",
        "createdAt",
        "complete",
        "files",
      ]) ||
      !Array.isArray(value.files) ||
      value.files.length > MAX_DATABASE_FILES
    )
      return null;
    const files: BackupManifestFileV1[] = [];
    const seen = new Set<string>();
    for (const entry of value.files) {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ["path", "bytes", "sha256"]) ||
        !validFileCore(entry) ||
        entry.path === MANIFEST_FILE ||
        seen.has(entry.path as string)
      )
        return null;
      seen.add(entry.path as string);
      files.push(entry as unknown as BackupManifestFileV1);
    }
    if (
      !files.every(
        (file, index) => index === 0 || files[index - 1]!.path < file.path,
      )
    )
      return null;
    if (!validateTotalBytes(files)) return null;
    return value as unknown as BackupManifestV1;
  }

  if (value.formatVersion !== 2) return null;
  if (
    !hasExactKeys(value, [
      "formatVersion",
      "id",
      "buildMarker",
      "createdAt",
      "complete",
      "owners",
      "files",
    ]) ||
    !Array.isArray(value.owners) ||
    !Array.isArray(value.files)
  )
    return null;
  if (
    value.owners.length !== 2 ||
    !isRecord(value.owners[0]) ||
    !hasExactKeys(value.owners[0], ["owner", "root"]) ||
    value.owners[0].owner !== "database" ||
    value.owners[0].root !== "database" ||
    !isRecord(value.owners[1]) ||
    !hasExactKeys(value.owners[1], ["owner", "root"]) ||
    value.owners[1].owner !== "settings" ||
    value.owners[1].root !== "config"
  )
    return null;
  if (value.files.length > MAX_DATABASE_FILES + 1) return null;

  const files: BackupManifestFileV2[] = [];
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["owner", "path", "bytes", "sha256", "mode"]) ||
      (entry.owner !== "database" && entry.owner !== "settings") ||
      !validFileCore(entry) ||
      entry.mode !== 0o600
    )
      return null;
    const key = `${entry.owner}:${entry.path}`;
    if (seen.has(key)) return null;
    seen.add(key);
    files.push(entry as unknown as BackupManifestFileV2);
  }
  if (
    !files.every(
      (file, index) =>
        index === 0 || compareManifestFiles(files[index - 1]!, file) < 0,
    )
  ) {
    return null;
  }
  const databaseFiles = files.filter((file) => file.owner === "database");
  const settingsFiles = files.filter((file) => file.owner === "settings");
  if (databaseFiles.length > MAX_DATABASE_FILES) return null;
  if (
    settingsFiles.length !== 1 ||
    settingsFiles[0]!.path !== "settings.json" ||
    settingsFiles[0]!.bytes > MAX_SETTINGS_BYTES
  )
    return null;
  if (!validateTotalBytes(files)) return null;
  return value as unknown as BackupManifestV2;
}

async function assertPaths(
  paths: BackupPaths,
  requireConfig = true,
): Promise<Required<BackupPaths>> {
  const configInput = paths.config ?? join(paths.root, "config");
  if (resolve(configInput) !== resolve(paths.root, "config")) {
    throw new Error("Backup paths must use canonical Qali owner roots");
  }
  for (const path of [paths.root, paths.database, paths.backups]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        "Backup owner roots may not be symbolic and must be regular directories",
      );
    }
  }
  const root = await realpath(paths.root);
  const database = await realpath(paths.database);
  const backups = await realpath(paths.backups);
  let config = resolve(configInput);
  try {
    const metadata = await lstat(configInput);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        "Backup owner roots may not be symbolic and must be regular directories",
      );
    }
    config = await realpath(configInput);
  } catch (error) {
    if (requireConfig || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    config = resolve(root, "config");
  }
  if (
    database !== resolve(root, "database") ||
    config !== resolve(root, "config") ||
    backups !== resolve(root, "backups") ||
    !isContainedBy(root, database) ||
    !isContainedBy(root, config) ||
    !isContainedBy(root, backups)
  ) {
    throw new Error("Backup paths must use canonical Qali owner roots");
  }
  for (const path of [root, database, backups]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Backup owner roots must be regular directories");
    }
  }
  return { root, database, config, backups };
}

async function listRegularFiles(
  root: string,
  current = root,
  files: string[] = [],
  maximumFiles = MAX_DATABASE_FILES + 2,
): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(current, entry.name);
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink())
      throw new Error("Backup sources may not contain symbolic links");
    if (metadata.isDirectory()) {
      await listRegularFiles(root, entryPath, files, maximumFiles);
    } else if (metadata.isFile()) {
      files.push(relative(root, entryPath).split(sep).join("/"));
      if (files.length > maximumFiles) {
        throw new Error("Backup contains too many files");
      }
    } else {
      throw new Error(
        "Backup sources may contain only regular files and directories",
      );
    }
  }
  if (current === root) files.sort(compareCodeUnits);
  return files;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporaryPath, path);
}

function createBackupId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

type BackupSource = Readonly<{
  owner: BackupOwner;
  source: string;
  path: string;
  bytes: number;
  device: number;
  inode: number;
  modifiedMs: number;
}>;

function sameSource(metadata: Stats, source: BackupSource): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size === source.bytes &&
    metadata.dev === source.device &&
    metadata.ino === source.inode &&
    metadata.mtimeMs === source.modifiedMs
  );
}

async function inspectBackupSource(
  owner: BackupOwner,
  source: string,
  path: string,
): Promise<BackupSource> {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Backup ${owner} source must be a regular file without symbolic links`,
    );
  }
  const limit = owner === "settings" ? MAX_SETTINGS_BYTES : MAX_BACKUP_BYTES;
  if (metadata.size > limit)
    throw new Error(`Backup ${owner} source exceeds its size limit`);
  return Object.freeze({
    owner,
    source,
    path,
    bytes: metadata.size,
    device: metadata.dev,
    inode: metadata.ino,
    modifiedMs: metadata.mtimeMs,
  });
}

async function copyAndDescribe(
  source: BackupSource,
  target: string,
  copied: { bytes: number },
): Promise<BackupManifestFileV2> {
  const sourceMetadata = await lstat(source.source);
  if (!sameSource(sourceMetadata, source))
    throw new Error(`Backup ${source.owner} source changed during backup`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source.source, target);
  await chmod(target, 0o600);
  const [metadata, currentSourceMetadata] = await Promise.all([
    stat(target),
    lstat(source.source),
  ]);
  if (
    !sameSource(currentSourceMetadata, source) ||
    metadata.size !== source.bytes
  )
    throw new Error(`Backup ${source.owner} source changed during backup`);
  copied.bytes += metadata.size;
  if (!Number.isSafeInteger(copied.bytes) || copied.bytes > MAX_BACKUP_BYTES)
    throw new Error("Backup exceeds its total size limit");
  return Object.freeze({
    owner: source.owner,
    path: source.path,
    bytes: metadata.size,
    sha256: await hashFile(target),
    mode: 0o600,
  });
}

export async function createColdBackup(
  paths: BackupPaths,
  buildMarker: string,
  now = new Date(),
): Promise<ColdBackup> {
  if (!buildMarker || Buffer.byteLength(buildMarker, "utf8") > 512) {
    throw new Error("Invalid backup build marker");
  }
  const safe = await assertPaths(paths);
  const settingsSource = join(safe.config, "settings.json");
  const settingsMetadata = await lstat(settingsSource).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Backup settings document is unavailable");
    }
    throw error;
  });
  if (!settingsMetadata.isFile() || settingsMetadata.isSymbolicLink()) {
    throw new Error(
      "Backup settings document may not be symbolic and must be a regular file",
    );
  }
  if (settingsMetadata.size > MAX_SETTINGS_BYTES) {
    throw new Error("Backup settings document exceeds its size limit");
  }
  const databaseFiles = await listRegularFiles(
    safe.database,
    safe.database,
    [],
    MAX_DATABASE_FILES,
  );
  if (databaseFiles.length > MAX_DATABASE_FILES)
    throw new Error("Backup database contains too many files");
  const sources = await Promise.all([
    ...databaseFiles.map((path) =>
      inspectBackupSource("database", join(safe.database, path), path),
    ),
    inspectBackupSource("settings", settingsSource, "settings.json"),
  ]);
  if (!validateTotalBytes(sources))
    throw new Error("Backup exceeds its total size limit");

  const id = createBackupId(now);
  const staging = join(safe.backups, `.staging-${id}`);
  const destination = join(safe.backups, id);
  await mkdir(staging, { mode: 0o700 });
  const incomplete = {
    formatVersion: 2,
    id,
    buildMarker,
    createdAt: now.toISOString(),
    complete: false,
    owners: V2_OWNERS,
    files: [],
  } as const;
  await atomicJson(join(staging, MANIFEST_FILE), incomplete);

  try {
    const files: BackupManifestFileV2[] = [];
    const copied = { bytes: 0 };
    for (const source of sources) {
      files.push(
        await copyAndDescribe(
          source,
          join(
            staging,
            source.owner === "database" ? "database" : "config",
            source.path,
          ),
          copied,
        ),
      );
    }
    const manifest: BackupManifestV2 = {
      formatVersion: 2,
      id,
      buildMarker,
      createdAt: now.toISOString(),
      complete: true,
      owners: V2_OWNERS,
      files,
    };
    await atomicJson(join(staging, MANIFEST_FILE), manifest);
    if (!(await verifyBackupContents(staging, false)))
      throw new Error("Cold backup verification failed");
    await rename(staging, destination);
    return Object.freeze({ id, path: destination, manifest });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(
  backupPath: string,
): Promise<BackupManifest | null> {
  const manifestPath = join(backupPath, MANIFEST_FILE);
  const metadata = await lstat(manifestPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_MANIFEST_BYTES
  ) {
    return null;
  }
  return parseBackupManifest(JSON.parse(await readFile(manifestPath, "utf8")));
}

function physicalFilePath(
  manifest: BackupManifest,
  file: BackupManifestFileV1 | BackupManifestFileV2,
): string {
  if (manifest.formatVersion === 1) return file.path;
  const owned = file as BackupManifestFileV2;
  return join(owned.owner === "database" ? "database" : "config", owned.path)
    .split(sep)
    .join("/");
}

async function verifyFiles(
  root: string,
  manifest: BackupManifest,
  files: readonly (BackupManifestFileV1 | BackupManifestFileV2)[],
  ownerRootOnDisk: boolean,
): Promise<boolean> {
  const actualFiles = (
    await listRegularFiles(root, root, [], files.length + 1)
  ).filter((path) => path !== MANIFEST_FILE);
  const expectedFiles = files
    .map((file) =>
      ownerRootOnDisk ? physicalFilePath(manifest, file) : file.path,
    )
    .sort(compareCodeUnits);
  if (
    actualFiles.length !== expectedFiles.length ||
    !actualFiles.every((path, index) => path === expectedFiles[index])
  )
    return false;
  for (const file of files) {
    const expected = ownerRootOnDisk
      ? physicalFilePath(manifest, file)
      : file.path;
    const target = resolve(root, expected);
    if (!isContainedBy(root, target)) return false;
    const metadata = await lstat(target);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== file.bytes
    )
      return false;
    if (
      manifest.formatVersion === 2 &&
      (metadata.mode & 0o777) !== (file as BackupManifestFileV2).mode
    ) {
      return false;
    }
    if ((await hashFile(target)) !== file.sha256) return false;
  }
  return true;
}

async function verifyBackupContents(
  backupPath: string,
  enforceDirectoryName: boolean,
): Promise<boolean> {
  try {
    const metadata = await lstat(backupPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const root = await realpath(backupPath);
    const manifest = await readManifest(root);
    if (
      !manifest ||
      (enforceDirectoryName && join(dirname(root), manifest.id) !== root)
    )
      return false;
    return await verifyFiles(root, manifest, manifest.files, true);
  } catch {
    return false;
  }
}

export async function verifyBackup(backupPath: string): Promise<boolean> {
  return await verifyBackupContents(backupPath, true);
}

function manifestFilesForOwner(
  manifest: BackupManifest,
  owner: BackupOwner,
): readonly (BackupManifestFileV1 | BackupManifestFileV2)[] {
  if (manifest.formatVersion === 1)
    return owner === "database" ? manifest.files : [];
  return manifest.files.filter((file) => file.owner === owner);
}

async function copyOwnerFiles(
  backupPath: string,
  manifest: BackupManifest,
  owner: BackupOwner,
  destination: string,
): Promise<void> {
  const files = manifestFilesForOwner(manifest, owner);
  for (const file of files) {
    const sourceRelative =
      manifest.formatVersion === 1
        ? file.path
        : physicalFilePath(manifest, file);
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(backupPath, sourceRelative), target);
    await chmod(
      target,
      manifest.formatVersion === 2
        ? (file as BackupManifestFileV2).mode
        : 0o600,
    );
  }
  await copyFile(
    join(backupPath, MANIFEST_FILE),
    join(destination, MANIFEST_FILE),
  );
  await chmod(join(destination, MANIFEST_FILE), 0o600);
}

export async function stageVerifiedBackup(
  id: string,
  paths: BackupPaths,
): Promise<StagedBackup> {
  if (!BACKUP_ID.test(id)) throw new Error("Invalid backup identifier");
  let safe = await assertPaths(paths, false);
  const backupPath = join(safe.backups, id);
  if (!(await verifyBackup(backupPath)))
    throw new Error("Backup verification failed");
  const manifest = await readManifest(backupPath);
  if (!manifest) throw new Error("Backup manifest is invalid");
  if (manifest.formatVersion === 2) safe = await assertPaths(paths, true);
  const databaseStagingPath = join(
    safe.root,
    `.database-restore-${randomUUID()}`,
  );
  const settingsStagingPath =
    manifest.formatVersion === 2
      ? join(safe.root, `.settings-restore-${randomUUID()}`)
      : null;
  await mkdir(databaseStagingPath, { mode: 0o700 });
  if (settingsStagingPath) await mkdir(settingsStagingPath, { mode: 0o700 });
  try {
    await copyOwnerFiles(backupPath, manifest, "database", databaseStagingPath);
    if (!(await verifyStagedBackup(databaseStagingPath, "database"))) {
      throw new Error("Backup staged database verification failed");
    }
    if (settingsStagingPath) {
      await copyOwnerFiles(
        backupPath,
        manifest,
        "settings",
        settingsStagingPath,
      );
      if (!(await verifyStagedBackup(settingsStagingPath, "settings"))) {
        throw new Error("Backup staged settings verification failed");
      }
    }
    return Object.freeze({
      manifest,
      stagingPath: databaseStagingPath,
      databaseStagingPath,
      settingsStagingPath,
    });
  } catch (error) {
    await Promise.all([
      rm(databaseStagingPath, { recursive: true, force: true }),
      ...(settingsStagingPath
        ? [rm(settingsStagingPath, { recursive: true, force: true })]
        : []),
    ]);
    throw error;
  }
}

export async function verifyStagedBackup(
  stagingPath: string,
  owner: BackupOwner = "database",
): Promise<boolean> {
  try {
    const metadata = await lstat(stagingPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    const root = await realpath(stagingPath);
    const manifest = await readManifest(root);
    if (!manifest || (manifest.formatVersion === 1 && owner !== "database"))
      return false;
    return await verifyFiles(
      root,
      manifest,
      manifestFilesForOwner(manifest, owner),
      false,
    );
  } catch {
    return false;
  }
}

export async function removeStagedBackupManifest(
  stagingPath: string,
): Promise<void> {
  await rm(join(stagingPath, MANIFEST_FILE), { force: true });
}

export async function restoreVerifiedBackup(
  id: string,
  paths: BackupPaths,
): Promise<void> {
  if (!BACKUP_ID.test(id)) throw new Error("Invalid backup identifier");
  const staged = await stageVerifiedBackup(id, paths);
  const safe = await assertPaths(paths, staged.manifest.formatVersion === 2);
  if (!(await verifyStagedBackup(staged.databaseStagingPath, "database"))) {
    throw new Error("Backup staged database verification failed");
  }
  if (
    staged.settingsStagingPath &&
    !(await verifyStagedBackup(staged.settingsStagingPath, "settings"))
  )
    throw new Error("Backup staged settings verification failed");
  await removeStagedBackupManifest(staged.databaseStagingPath);
  if (staged.settingsStagingPath)
    await removeStagedBackupManifest(staged.settingsStagingPath);

  const displacedDatabase = join(
    safe.root,
    `.database-displaced-${randomUUID()}`,
  );
  const displacedSettings = join(
    safe.root,
    `.settings-displaced-${randomUUID()}.json`,
  );
  const settingsTarget = join(safe.config, "settings.json");
  let databaseDisplaced = false;
  let databaseActivated = false;
  let settingsDisplaced = false;
  let settingsActivated = false;
  try {
    await rename(safe.database, displacedDatabase);
    databaseDisplaced = true;
    if (staged.settingsStagingPath) {
      try {
        await rename(settingsTarget, displacedSettings);
        settingsDisplaced = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rename(staged.databaseStagingPath, safe.database);
    databaseActivated = true;
    if (staged.settingsStagingPath) {
      await rename(
        join(staged.settingsStagingPath, "settings.json"),
        settingsTarget,
      );
      settingsActivated = true;
      await rm(staged.settingsStagingPath, { recursive: true, force: true });
    }
    await rm(displacedDatabase, { recursive: true, force: true });
    if (settingsDisplaced) await rm(displacedSettings, { force: true });
  } catch (error) {
    if (settingsActivated) await rm(settingsTarget, { force: true });
    if (settingsDisplaced) await rename(displacedSettings, settingsTarget);
    if (databaseActivated)
      await rm(safe.database, { recursive: true, force: true });
    if (databaseDisplaced) await rename(displacedDatabase, safe.database);
    await Promise.all([
      rm(staged.databaseStagingPath, { recursive: true, force: true }),
      ...(staged.settingsStagingPath
        ? [rm(staged.settingsStagingPath, { recursive: true, force: true })]
        : []),
    ]);
    throw error;
  }
}
