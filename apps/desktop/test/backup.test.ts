import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createColdBackup,
  parseBackupManifest,
  restoreVerifiedBackup,
  stageVerifiedBackup,
  verifyBackup,
  verifyStagedBackup,
  type BackupPaths,
} from "../src/main/convex/backup";

const temporaryRoots: string[] = [];

async function fixtureStateWithWal(): Promise<BackupPaths> {
  const root = await mkdtemp(join(tmpdir(), "qali-convex-backup-"));
  temporaryRoots.push(root);
  const database = join(root, "database");
  const config = join(root, "config");
  const backups = join(root, "backups");
  await mkdir(join(database, "modules"), { recursive: true });
  await mkdir(config, { recursive: true });
  await mkdir(backups, { recursive: true });
  await writeFile(join(database, "convex.sqlite3"), "database-v1");
  await writeFile(join(database, "convex.sqlite3-wal"), "wal-v1");
  await writeFile(join(database, "convex.sqlite3-shm"), "shm-v1");
  await writeFile(join(database, "modules", "bundle.js"), "module-v1");
  await writeFile(join(config, "settings.json"), '{"theme":"dark"}\n');
  await writeFile(join(config, "credential-canary"), "must-never-be-backed-up");
  return { root, database, config, backups };
}

async function writeLegacyV1Backup(paths: BackupPaths): Promise<string> {
  const id = "20260819T100001000Z-aaaaaaaaaaaa";
  const backup = join(paths.backups, id);
  const contents = "legacy-database";
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, "state.db"), contents);
  await writeFile(
    join(backup, "backup-manifest.json"),
    `${JSON.stringify({
      formatVersion: 1,
      id,
      buildMarker: "desktop-schema-v1",
      createdAt: "2026-08-19T10:00:01.000Z",
      complete: true,
      files: [
        {
          path: "state.db",
          bytes: Buffer.byteLength(contents),
          sha256: createHash("sha256").update(contents).digest("hex"),
        },
      ],
    })}\n`,
  );
  return id;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("cold Convex backups", () => {
  test("writes a canonical two-owner v2 manifest without exporting other config files", async () => {
    const paths = await fixtureStateWithWal();
    const backup = await createColdBackup(paths, "desktop-schema-v1");

    expect(backup.manifest).toMatchObject({
      formatVersion: 2,
      complete: true,
      owners: [
        { owner: "database", root: "database" },
        { owner: "settings", root: "config" },
      ],
    });
    if (backup.manifest.formatVersion !== 2)
      throw new Error("Expected v2 backup");
    expect(
      backup.manifest.files.map(({ owner, path, mode }) => ({
        owner,
        path,
        mode,
      })),
    ).toEqual([
      { owner: "database", path: "convex.sqlite3", mode: 0o600 },
      { owner: "database", path: "convex.sqlite3-shm", mode: 0o600 },
      { owner: "database", path: "convex.sqlite3-wal", mode: 0o600 },
      { owner: "database", path: "modules/bundle.js", mode: 0o600 },
      { owner: "settings", path: "settings.json", mode: 0o600 },
    ]);
    expect(
      backup.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
    ).toBe(true);
    await expect(
      readFile(join(backup.path, "config", "settings.json"), "utf8"),
    ).resolves.toBe('{"theme":"dark"}\n');
    await expect(
      readFile(join(backup.path, "config", "credential-canary"), "utf8"),
    ).rejects.toThrow();
    expect(
      await readFile(join(backup.path, "backup-manifest.json"), "utf8"),
    ).not.toContain("must-never-be-backed-up");
    await expect(verifyBackup(backup.path)).resolves.toBe(true);
  });

  test("sorts generated paths with the parser's code-unit canonical order", async () => {
    const paths = await fixtureStateWithWal();
    await mkdir(join(paths.database, "a"));
    await writeFile(join(paths.database, "a", "file"), "nested");
    await writeFile(join(paths.database, "a-"), "sibling");

    const backup = await createColdBackup(paths, "desktop-schema-v1");
    if (backup.manifest.formatVersion !== 2)
      throw new Error("Expected v2 backup");

    const generatedPaths = backup.manifest.files
      .filter((file) => file.owner === "database")
      .map((file) => file.path);
    expect(generatedPaths.indexOf("a-")).toBeLessThan(
      generatedPaths.indexOf("a/file"),
    );
    await expect(verifyBackup(backup.path)).resolves.toBe(true);
  });

  test("rejects creating v2 without the exact regular settings document", async () => {
    const missing = await fixtureStateWithWal();
    await rm(join(missing.config!, "settings.json"));
    await expect(
      createColdBackup(missing, "desktop-schema-v1"),
    ).rejects.toThrow("settings");

    const linked = await fixtureStateWithWal();
    const outside = join(linked.root, "outside-settings.json");
    await writeFile(outside, "{}\n");
    await rm(join(linked.config!, "settings.json"));
    await symlink(outside, join(linked.config!, "settings.json"));
    await expect(createColdBackup(linked, "desktop-schema-v1")).rejects.toThrow(
      "symbolic",
    );
  });

  test("rejects a symbolic application root even when every owner resolves canonically", async () => {
    const paths = await fixtureStateWithWal();
    const alias = `${paths.root}-alias`;
    temporaryRoots.push(alias);
    await symlink(paths.root, alias, "dir");

    await expect(
      createColdBackup(
        {
          root: alias,
          database: join(alias, "database"),
          config: join(alias, "config"),
          backups: join(alias, "backups"),
        },
        "desktop-schema-v1",
      ),
    ).rejects.toThrow("symbolic");
  });

  test("rejects non-canonical, unknown, oversized, and traversing v2 manifests", () => {
    const base = {
      formatVersion: 2,
      id: "20260819T100001000Z-aaaaaaaaaaaa",
      buildMarker: "desktop-schema-v1",
      createdAt: "2026-08-19T10:00:01.000Z",
      complete: true,
      owners: [
        { owner: "database", root: "database" },
        { owner: "settings", root: "config" },
      ],
      files: [
        {
          owner: "database",
          path: "state.db",
          bytes: 1,
          sha256: "a".repeat(64),
          mode: 0o600,
        },
        {
          owner: "settings",
          path: "settings.json",
          bytes: 2,
          sha256: "b".repeat(64),
          mode: 0o600,
        },
      ],
    } as const;

    expect(parseBackupManifest({ ...base, formatVersion: 3 })).toBeNull();
    expect(parseBackupManifest({ ...base, extra: true })).toBeNull();
    expect(
      parseBackupManifest({
        ...base,
        owners: [
          { owner: "database", root: "database" },
          { owner: "secrets", root: "config" },
        ],
      }),
    ).toBeNull();
    expect(
      parseBackupManifest({
        ...base,
        files: [{ ...base.files[0], path: "../escape" }, base.files[1]],
      }),
    ).toBeNull();
    expect(
      parseBackupManifest({
        ...base,
        files: [
          { ...base.files[0], bytes: Number.MAX_SAFE_INTEGER },
          base.files[1],
        ],
      }),
    ).toBeNull();
    expect(
      parseBackupManifest({
        ...base,
        files: [{ ...base.files[0], unexpected: true }, base.files[1]],
      }),
    ).toBeNull();
    expect(
      parseBackupManifest({
        ...base,
        files: [base.files[1], base.files[0]],
      }),
    ).toBeNull();
    expect(
      parseBackupManifest({
        ...base,
        files: [base.files[0]],
      }),
    ).toBeNull();
    expect(parseBackupManifest(base)).not.toBeNull();
  });

  test("rejects a database inventory above the bounded file count", () => {
    const databaseFiles = Array.from({ length: 10_001 }, (_, index) => ({
      owner: "database" as const,
      path: `file-${String(index).padStart(5, "0")}`,
      bytes: 0,
      sha256: "a".repeat(64),
      mode: 0o600 as const,
    }));
    expect(
      parseBackupManifest({
        formatVersion: 2,
        id: "20260819T100001000Z-aaaaaaaaaaaa",
        buildMarker: "desktop-schema-v1",
        createdAt: "2026-08-19T10:00:01.000Z",
        complete: true,
        owners: [
          { owner: "database", root: "database" },
          { owner: "settings", root: "config" },
        ],
        files: [
          ...databaseFiles,
          {
            owner: "settings",
            path: "settings.json",
            bytes: 2,
            sha256: "b".repeat(64),
            mode: 0o600,
          },
        ],
      }),
    ).toBeNull();
  });

  test("accepts exactly 10,000 database files plus settings and the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-convex-boundary-"));
    temporaryRoots.push(root);
    const database = join(root, "database");
    const config = join(root, "config");
    const backups = join(root, "backups");
    const id = "20260819T100001000Z-bbbbbbbbbbbb";
    const backupPath = join(backups, id);
    await mkdir(database);
    await mkdir(config);
    await mkdir(join(backupPath, "database"), { recursive: true });
    await mkdir(join(backupPath, "config"));
    const emptyHash = createHash("sha256").update("").digest("hex");
    const databaseFiles = Array.from({ length: 10_000 }, (_, index) => ({
      owner: "database" as const,
      path: `file-${String(index).padStart(5, "0")}`,
      bytes: 0,
      sha256: emptyHash,
      mode: 0o600 as const,
    }));
    for (let offset = 0; offset < databaseFiles.length; offset += 200) {
      await Promise.all(
        databaseFiles.slice(offset, offset + 200).map((file) =>
          writeFile(join(backupPath, "database", file.path), "", {
            mode: 0o600,
          }),
        ),
      );
    }
    await writeFile(join(backupPath, "config", "settings.json"), "", {
      mode: 0o600,
    });
    const manifest = {
      formatVersion: 2,
      id,
      buildMarker: "desktop-schema-v1",
      createdAt: "2026-08-19T10:00:01.000Z",
      complete: true,
      owners: [
        { owner: "database", root: "database" },
        { owner: "settings", root: "config" },
      ],
      files: [
        ...databaseFiles,
        {
          owner: "settings",
          path: "settings.json",
          bytes: 0,
          sha256: emptyHash,
          mode: 0o600,
        },
      ],
    } as const;
    expect(parseBackupManifest(manifest)).not.toBeNull();
    await writeFile(
      join(backupPath, "backup-manifest.json"),
      `${JSON.stringify(manifest)}\n`,
      { mode: 0o600 },
    );

    await expect(verifyBackup(backupPath)).resolves.toBe(true);
  }, 20_000);

  test("rejects an oversized aggregate before writing to the backup volume", async () => {
    const paths = await fixtureStateWithWal();
    await truncate(join(paths.database, "convex.sqlite3"), 32 * 1024 ** 3);
    await truncate(join(paths.database, "convex.sqlite3-wal"), 32 * 1024 ** 3);
    await chmod(paths.backups, 0o500);

    await expect(createColdBackup(paths, "desktop-schema-v1")).rejects.toThrow(
      "total size",
    );
  });

  test("rejects a backup whose manifest or owner inventory does not match disk", async () => {
    const paths = await fixtureStateWithWal();
    const backup = await createColdBackup(paths, "desktop-schema-v1");
    await writeFile(
      join(backup.path, "database", "convex.sqlite3-wal"),
      "tampered",
    );

    await expect(verifyBackup(backup.path)).resolves.toBe(false);
  });

  test("stages and rehashes database and settings independently", async () => {
    const paths = await fixtureStateWithWal();
    const backup = await createColdBackup(paths, "desktop-schema-v1");
    const staged = await stageVerifiedBackup(backup.id, paths);

    expect(staged.stagingPath).toBe(staged.databaseStagingPath);
    expect(staged.settingsStagingPath).not.toBeNull();
    await expect(
      verifyStagedBackup(staged.databaseStagingPath, "database"),
    ).resolves.toBe(true);
    await expect(
      verifyStagedBackup(staged.settingsStagingPath!, "settings"),
    ).resolves.toBe(true);

    await writeFile(
      join(staged.settingsStagingPath!, "settings.json"),
      "tampered",
    );
    await expect(
      verifyStagedBackup(staged.databaseStagingPath, "database"),
    ).resolves.toBe(true);
    await expect(
      verifyStagedBackup(staged.settingsStagingPath!, "settings"),
    ).resolves.toBe(false);
  });

  test("keeps v1 database-only backups readable and preserves current settings", async () => {
    const paths = await fixtureStateWithWal();
    const id = await writeLegacyV1Backup(paths);
    await writeFile(join(paths.database, "state.db"), "current-database");
    await writeFile(
      join(paths.config!, "settings.json"),
      '{"theme":"light"}\n',
    );

    await expect(verifyBackup(join(paths.backups, id))).resolves.toBe(true);
    const staged = await stageVerifiedBackup(id, paths);
    expect(staged.settingsStagingPath).toBeNull();
    expect(staged.stagingPath).toBe(staged.databaseStagingPath);
    await restoreVerifiedBackup(id, paths);

    await expect(
      readFile(join(paths.database, "state.db"), "utf8"),
    ).resolves.toBe("legacy-database");
    await expect(
      readFile(join(paths.config!, "settings.json"), "utf8"),
    ).resolves.toBe('{"theme":"light"}\n');
  });

  test("stages and restores v1 backups when the config root does not exist", async () => {
    const paths = await fixtureStateWithWal();
    const id = await writeLegacyV1Backup(paths);
    await rm(paths.config!, { recursive: true });
    const pathsWithoutConfig = {
      root: paths.root,
      database: paths.database,
      backups: paths.backups,
    };

    const staged = await stageVerifiedBackup(id, pathsWithoutConfig);
    expect(staged.settingsStagingPath).toBeNull();
    await restoreVerifiedBackup(id, pathsWithoutConfig);

    await expect(
      readFile(join(paths.database, "state.db"), "utf8"),
    ).resolves.toBe("legacy-database");
    await expect(
      readFile(join(paths.root, "config", "settings.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("restores both v2 owners after fully verifying their staged copies", async () => {
    const paths = await fixtureStateWithWal();
    const backup = await createColdBackup(paths, "desktop-schema-v1");
    await writeFile(join(paths.database, "convex.sqlite3"), "database-v2");
    await writeFile(join(paths.database, "later-state"), "must-disappear");
    await writeFile(
      join(paths.config!, "settings.json"),
      '{"theme":"light"}\n',
    );

    await restoreVerifiedBackup(backup.id, paths);

    expect(await readFile(join(paths.database, "convex.sqlite3"), "utf8")).toBe(
      "database-v1",
    );
    await expect(
      readFile(join(paths.database, "later-state"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(paths.config!, "settings.json"), "utf8"),
    ).resolves.toBe('{"theme":"dark"}\n');
    await expect(verifyBackup(backup.path)).resolves.toBe(true);
  });
});
