import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { createColdBackup } from "../src/main/convex/backup";
import { exportLocalData } from "../src/main/recovery/export";
import {
  createRecoveryAuthority,
  finalizePendingRestore,
  listRecoveryBackups,
  prepareVerifiedRestore,
  recoverInterruptedRestore,
  rollbackPendingRestore,
  restoreLocalBackup,
} from "../src/main/recovery/restore";
import { resetLocalData } from "../src/main/recovery/reset";
import { QALI_KEYCHAIN_RECORDS } from "../src/main/keychain/keychain";

const roots: string[] = [];

async function fixture() {
  const appData = await mkdtemp(join(tmpdir(), "qali-recovery-parent-"));
  roots.push(appData);
  const namespace = "Qali Test";
  const root = join(appData, namespace);
  const database = join(root, "database");
  const config = join(root, "config");
  const backups = join(root, "backups");
  for (const directory of [
    database,
    backups,
    join(root, "runtime"),
    join(root, "logs"),
    join(root, "cache"),
    config,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(database, "state.db"), "calendar-v1");
  await writeFile(
    join(config, "settings.json"),
    '{"theme":"dark","revision":7}\n',
  );
  return {
    appData,
    namespace,
    root,
    database,
    config,
    backups,
    authority: await createRecoveryAuthority({
      appData,
      namespace,
      root,
      database,
      backups,
    }),
  };
}

async function writeRestoreCheckpoint(
  input: Readonly<{
    root: string;
    backupId: string;
    stagingPath: string;
    displacedPath: string;
    phase: "prepared" | "displaced" | "activated" | "verified";
  }>,
): Promise<void> {
  await writeFile(
    join(input.root, ".restore-pending.json"),
    `${JSON.stringify({
      version: 1,
      phase: input.phase,
      backupId: input.backupId,
      buildMarker: "desktop-schema-v1",
      staging: basename(input.stagingPath),
      displaced: basename(input.displacedPath),
    })}\n`,
  );
}

async function writeRestoreCheckpointV2(
  input: Readonly<{
    root: string;
    backupId: string;
    databaseStagingPath: string;
    settingsStagingPath: string;
    databaseDisplacedPath: string;
    settingsDisplacedPath: string;
    phase:
      | "verified"
      | "database-displaced"
      | "settings-displaced"
      | "database-activated"
      | "settings-activated";
  }>,
): Promise<void> {
  await writeFile(
    join(input.root, ".restore-pending.json"),
    `${JSON.stringify({
      version: 2,
      phase: input.phase,
      backupId: input.backupId,
      buildMarker: "desktop-schema-v1",
      databaseStaging: basename(input.databaseStagingPath),
      settingsStaging: basename(input.settingsStagingPath),
      databaseDisplaced: basename(input.databaseDisplacedPath),
      settingsDisplaced: basename(input.settingsDisplacedPath),
      settingsPreviouslyExisted: true,
    })}\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local recovery authority", () => {
  test("exports only schema-validated calendar/application data to a user-selected file", async () => {
    const data = await fixture();
    const destination = join(data.appData, "qali-calendar-export.json");
    const secret = "provider-secret-canary";
    const result = await exportLocalData({
      authority: data.authority,
      chooseDestination: async () => destination,
      loadSnapshot: async () => ({
        calendars: [
          {
            id: "cal_1",
            name: "Personal",
            color: "blue",
            credentialRef: secret,
          },
        ],
        events: [
          {
            id: "event_1",
            calendarId: "cal_1",
            title: "Dentist",
            startMs: 1_800_000_000_000,
            endMs: 1_800_000_003_600,
            attendees: [
              {
                email: "friend@example.com",
                displayName: "Friend",
                token: secret,
              },
            ],
            rawProviderPayload: secret,
          },
        ],
        pendingOperations: [
          {
            id: `op_${"b".repeat(32)}`,
            kind: "update",
            state: "pending",
            token: secret,
          },
        ],
        assistantProtocol: secret,
      }),
    });

    expect(result.kind).toBe("exported");
    const serialized = await readFile(destination, "utf8");
    expect(serialized).not.toContain(secret);
    expect(JSON.parse(serialized)).toMatchObject({
      formatVersion: 1,
      calendars: [{ id: "cal_1", name: "Personal", color: "blue" }],
      events: [{ id: "event_1", title: "Dentist" }],
      pendingOperations: [
        { id: `op_${"b".repeat(32)}`, kind: "update", state: "pending" },
      ],
    });
  });

  test("returns cancellation without creating an export", async () => {
    const data = await fixture();
    await expect(
      exportLocalData({
        authority: data.authority,
        chooseDestination: async () => null,
        loadSnapshot: async () => ({
          calendars: [],
          events: [],
          pendingOperations: [],
        }),
      }),
    ).resolves.toEqual({ kind: "cancelled" });
  });

  test("lists and restores verified backups only, staging before the active swap", async () => {
    const data = await fixture();
    const good = await createColdBackup(
      data,
      "desktop-schema-v1",
      new Date("2026-08-19T10:00:00Z"),
    );
    const bad = join(data.backups, "20260819T100001000Z-aaaaaaaaaaaa");
    await mkdir(bad);
    await writeFile(join(bad, "backup-manifest.json"), "{}");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    await writeFile(
      join(data.config, "settings.json"),
      '{"theme":"light","revision":8}\n',
    );

    await expect(listRecoveryBackups(data.authority)).resolves.toEqual([
      expect.objectContaining({ id: good.id, verified: true }),
    ]);
    await restoreLocalBackup({
      authority: data.authority,
      backupId: good.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v1");
    await expect(
      readFile(join(data.config, "settings.json"), "utf8"),
    ).resolves.toBe('{"theme":"dark","revision":7}\n');
    expect(
      (await readdir(data.root)).some((name) =>
        name.startsWith(".settings-restore-"),
      ),
    ).toBe(false);
  });

  test("rejects an incompatible build marker before displacing the active database", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v0");
    await writeFile(join(data.database, "state.db"), "calendar-v2");

    await expect(
      restoreLocalBackup({
        authority: data.authority,
        backupId: backup.id,
        expectedBuildMarker: "desktop-schema-v1",
        verifyRestoredDatabase: async () => {},
      }),
    ).rejects.toThrow("BACKUP_BUILD_INCOMPATIBLE");
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
  });

  test("rehashes the staged copy and rolls back when restored health fails", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    const tampered = await prepareVerifiedRestore({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
    });
    if (!tampered.settingsStagingPath)
      throw new Error("Expected v2 settings staging path");
    await writeFile(
      join(tampered.settingsStagingPath, "settings.json"),
      "tampered",
    );
    await expect(tampered.activate(async () => {})).rejects.toThrow("staged");
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");

    const unhealthy = await prepareVerifiedRestore({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
    });
    await writeFile(
      join(data.config, "settings.json"),
      '{"theme":"light","revision":8}\n',
    );
    await expect(
      unhealthy.activate(async () => {
        throw new Error("health failed");
      }),
    ).rejects.toThrow("health failed");
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
    await expect(
      readFile(join(data.config, "settings.json"), "utf8"),
    ).resolves.toBe('{"theme":"light","revision":8}\n');
  });

  test("health rollback restores an originally absent settings owner", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    await rm(join(data.config, "settings.json"));

    await expect(
      restoreLocalBackup({
        authority: data.authority,
        backupId: backup.id,
        expectedBuildMarker: "desktop-schema-v1",
        verifyRestoredDatabase: async () => {
          throw new Error("health failed");
        },
      }),
    ).rejects.toThrow("health failed");

    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
    await expect(
      readFile(join(data.config, "settings.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("retains the displaced store until a later healthy restart finalizes it", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    await writeFile(
      join(data.config, "settings.json"),
      '{"theme":"light","revision":8}\n',
    );

    const result = await restoreLocalBackup({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });
    await expect(
      readFile(join(result.displacedPath, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
    if (!result.settingsDisplacedPath)
      throw new Error("Expected displaced settings for v2 restore");
    await expect(readFile(result.settingsDisplacedPath, "utf8")).resolves.toBe(
      '{"theme":"light","revision":8}\n',
    );
    await finalizePendingRestore(data.authority);
    await expect(realpath(result.displacedPath)).rejects.toThrow();
    await expect(
      readFile(result.settingsDisplacedPath, "utf8"),
    ).rejects.toThrow();
  });

  test("startup aborts a prepared restore whether crash happened before or after displacement", async () => {
    for (const afterDisplacement of [false, true]) {
      const data = await fixture();
      const backup = await createColdBackup(data, "desktop-schema-v1");
      await writeFile(join(data.database, "state.db"), "calendar-v2");
      const prepared = await prepareVerifiedRestore({
        authority: data.authority,
        backupId: backup.id,
        expectedBuildMarker: "desktop-schema-v1",
      });
      const displacedPath = join(
        data.root,
        `.database-displaced-${afterDisplacement ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"}`,
      );
      await writeRestoreCheckpoint({
        root: data.root,
        backupId: backup.id,
        stagingPath: prepared.stagingPath,
        displacedPath,
        phase: "prepared",
      });
      if (afterDisplacement) await rename(data.database, displacedPath);

      const startupAuthority = afterDisplacement
        ? await createRecoveryAuthority({
            appData: data.appData,
            namespace: data.namespace,
            root: data.root,
            database: data.database,
            backups: data.backups,
          })
        : data.authority;

      await expect(
        recoverInterruptedRestore(startupAuthority),
      ).resolves.toEqual({
        kind: "rolled-back",
      });
      await expect(
        readFile(join(data.database, "state.db"), "utf8"),
      ).resolves.toBe("calendar-v2");
      await expect(realpath(prepared.stagingPath)).rejects.toThrow();
      await expect(
        readFile(join(data.root, ".restore-pending.json"), "utf8"),
      ).rejects.toThrow();
    }
  });

  test("startup removes an orphan staged copy created before the journal existed", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    const prepared = await prepareVerifiedRestore({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
    });

    await expect(recoverInterruptedRestore(data.authority)).resolves.toEqual({
      kind: "rolled-back",
    });
    await expect(realpath(prepared.stagingPath)).rejects.toThrow();
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v1");
  });

  test("startup preserves an orphan staged copy when no active store can be selected", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    const prepared = await prepareVerifiedRestore({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
    });
    await rm(data.database, { recursive: true });

    await expect(recoverInterruptedRestore(data.authority)).rejects.toThrow(
      "RESTORE_ROLLBACK_UNAVAILABLE",
    );
    await expect(realpath(prepared.stagingPath)).resolves.toBe(
      prepared.stagingPath,
    );
  });

  test("startup rolls back crashes around staged activation", async () => {
    for (const state of [
      "before-activation",
      "after-activation",
      "activated",
    ] as const) {
      const data = await fixture();
      const backup = await createColdBackup(data, "desktop-schema-v1");
      await writeFile(join(data.database, "state.db"), "calendar-v2");
      const prepared = await prepareVerifiedRestore({
        authority: data.authority,
        backupId: backup.id,
        expectedBuildMarker: "desktop-schema-v1",
      });
      const displacedPath = join(
        data.root,
        `.database-displaced-${state === "before-activation" ? "33333333-3333-4333-8333-333333333333" : state === "after-activation" ? "44444444-4444-4444-8444-444444444444" : "55555555-5555-4555-8555-555555555555"}`,
      );
      await rename(data.database, displacedPath);
      if (state !== "before-activation") {
        await rename(prepared.stagingPath, data.database);
      }
      await writeRestoreCheckpoint({
        root: data.root,
        backupId: backup.id,
        stagingPath: prepared.stagingPath,
        displacedPath,
        phase: state === "activated" ? "activated" : "displaced",
      });

      await expect(recoverInterruptedRestore(data.authority)).resolves.toEqual({
        kind: "rolled-back",
      });
      await expect(
        readFile(join(data.database, "state.db"), "utf8"),
      ).resolves.toBe("calendar-v2");
    }
  });

  test("startup rolls back both v2 owners from every journaled activation phase", async () => {
    const phases = [
      "verified",
      "database-displaced",
      "settings-displaced",
      "database-activated",
      "settings-activated",
    ] as const;
    for (const [index, phase] of phases.entries()) {
      const data = await fixture();
      const backup = await createColdBackup(data, "desktop-schema-v1");
      await writeFile(join(data.database, "state.db"), "calendar-v2");
      await writeFile(
        join(data.config, "settings.json"),
        '{"theme":"light","revision":8}\n',
      );
      const prepared = await prepareVerifiedRestore({
        authority: data.authority,
        backupId: backup.id,
        expectedBuildMarker: "desktop-schema-v1",
      });
      if (!prepared.settingsStagingPath)
        throw new Error("Expected v2 settings staging path");
      const digit = String(index + 1);
      const databaseDisplacedPath = join(
        data.root,
        `.database-displaced-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      );
      const settingsDisplacedPath = join(
        data.root,
        `.settings-displaced-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}.json`,
      );
      if (phase !== "verified")
        await rename(data.database, databaseDisplacedPath);
      if (
        phase === "settings-displaced" ||
        phase === "database-activated" ||
        phase === "settings-activated"
      ) {
        await rename(join(data.config, "settings.json"), settingsDisplacedPath);
      }
      if (phase === "database-activated" || phase === "settings-activated")
        await rename(prepared.databaseStagingPath, data.database);
      if (phase === "settings-activated") {
        await rename(
          join(prepared.settingsStagingPath, "settings.json"),
          join(data.config, "settings.json"),
        );
        await rm(prepared.settingsStagingPath, { recursive: true });
      }
      await writeRestoreCheckpointV2({
        root: data.root,
        backupId: backup.id,
        databaseStagingPath: prepared.databaseStagingPath,
        settingsStagingPath: prepared.settingsStagingPath,
        databaseDisplacedPath,
        settingsDisplacedPath,
        phase,
      });

      await expect(recoverInterruptedRestore(data.authority)).resolves.toEqual({
        kind: "rolled-back",
      });
      await expect(
        readFile(join(data.database, "state.db"), "utf8"),
      ).resolves.toBe("calendar-v2");
      await expect(
        readFile(join(data.config, "settings.json"), "utf8"),
      ).resolves.toBe('{"theme":"light","revision":8}\n');
      expect(
        (await readdir(data.root)).some(
          (name) =>
            name.startsWith(".database-restore-") ||
            name.startsWith(".settings-restore-") ||
            name.startsWith(".database-displaced-") ||
            name.startsWith(".settings-displaced-"),
        ),
      ).toBe(false);
    }
  });

  test("production restore keeps v1 database-only backups usable without config", async () => {
    const data = await fixture();
    const id = "20260819T100001000Z-cccccccccccc";
    const backupPath = join(data.backups, id);
    const contents = "legacy-database";
    await mkdir(backupPath);
    await writeFile(join(backupPath, "state.db"), contents);
    await writeFile(
      join(backupPath, "backup-manifest.json"),
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
    await rm(data.config, { recursive: true });
    const authority = await createRecoveryAuthority({
      appData: data.appData,
      namespace: data.namespace,
      root: data.root,
      database: data.database,
      backups: data.backups,
    });

    const result = await restoreLocalBackup({
      authority,
      backupId: id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });

    expect(result.settingsDisplacedPath).toBeNull();
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe(contents);
    await expect(
      readFile(join(data.config, "settings.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("startup selects a verified restored store until post-health finalization", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    const result = await restoreLocalBackup({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });

    await expect(recoverInterruptedRestore(data.authority)).resolves.toEqual({
      kind: "verified-pending",
    });
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v1");
    await expect(
      readFile(join(result.displacedPath, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
  });

  test("startup health failure rolls a verified restore back to the displaced store", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    const result = await restoreLocalBackup({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });

    await rollbackPendingRestore(data.authority);
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
    await expect(realpath(result.displacedPath)).rejects.toThrow();
    await expect(
      readFile(join(data.root, ".restore-pending.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("rollback never selects a mixed owner pair when displaced settings are unavailable", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    await writeFile(
      join(data.config, "settings.json"),
      '{"theme":"light","revision":8}\n',
    );
    const result = await restoreLocalBackup({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });
    if (!result.settingsDisplacedPath)
      throw new Error("Expected displaced settings for v2 restore");
    await rm(result.settingsDisplacedPath);

    await expect(rollbackPendingRestore(data.authority)).rejects.toThrow(
      "RESTORE_ROLLBACK_UNAVAILABLE",
    );
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v1");
    await expect(
      readFile(join(data.config, "settings.json"), "utf8"),
    ).resolves.toBe('{"theme":"dark","revision":7}\n');
    await expect(
      readFile(join(data.root, ".restore-pending.json"), "utf8"),
    ).resolves.toContain("runtime-healthy");
  });

  test("startup completes rollback when a crash removed the verified active store", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    await restoreLocalBackup({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });
    await rm(data.database, { recursive: true });

    await expect(recoverInterruptedRestore(data.authority)).resolves.toEqual({
      kind: "rolled-back",
    });
    await expect(
      readFile(join(data.database, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
  });

  test("finalization never removes the displaced store when the active store is missing", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    const result = await restoreLocalBackup({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });
    await rm(data.database, { recursive: true });

    await expect(finalizePendingRestore(data.authority)).rejects.toThrow(
      "RESTORE_VERIFIED_STORE_MISSING",
    );
    await expect(
      readFile(join(result.displacedPath, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
    await expect(
      readFile(join(data.root, ".restore-pending.json"), "utf8"),
    ).resolves.toContain("runtime-healthy");
  });

  test("finalization retains both displaced owners when active settings are missing", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    await writeFile(join(data.database, "state.db"), "calendar-v2");
    await writeFile(
      join(data.config, "settings.json"),
      '{"theme":"light","revision":8}\n',
    );
    const result = await restoreLocalBackup({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
      verifyRestoredDatabase: async () => {},
    });
    if (!result.settingsDisplacedPath)
      throw new Error("Expected displaced settings for v2 restore");
    await rm(join(data.config, "settings.json"));

    await expect(finalizePendingRestore(data.authority)).rejects.toThrow(
      "RESTORE_VERIFIED_STORE_MISSING",
    );
    await expect(
      readFile(join(result.displacedPath, "state.db"), "utf8"),
    ).resolves.toBe("calendar-v2");
    await expect(readFile(result.settingsDisplacedPath, "utf8")).resolves.toBe(
      '{"theme":"light","revision":8}\n',
    );
    await expect(
      readFile(join(data.root, ".restore-pending.json"), "utf8"),
    ).resolves.toContain("runtime-healthy");
  });

  test("checkpoint remains when an interrupted restore cannot be rolled back", async () => {
    const data = await fixture();
    const backup = await createColdBackup(data, "desktop-schema-v1");
    const prepared = await prepareVerifiedRestore({
      authority: data.authority,
      backupId: backup.id,
      expectedBuildMarker: "desktop-schema-v1",
    });
    const displacedPath = join(
      data.root,
      ".database-displaced-66666666-6666-4666-8666-666666666666",
    );
    await writeRestoreCheckpoint({
      root: data.root,
      backupId: backup.id,
      stagingPath: prepared.stagingPath,
      displacedPath,
      phase: "displaced",
    });
    await rm(data.database, { recursive: true });

    await expect(recoverInterruptedRestore(data.authority)).rejects.toThrow(
      "RESTORE_ROLLBACK_UNAVAILABLE",
    );
    await expect(
      readFile(join(data.root, ".restore-pending.json"), "utf8"),
    ).resolves.toContain("displaced");
  });

  test("rejects arbitrary roots, traversal, symlinks, and incomplete backups", async () => {
    const data = await fixture();
    await expect(
      createRecoveryAuthority({
        appData: dirname(data.appData),
        namespace: basename(data.appData),
        root: data.appData,
        database: data.database,
        backups: data.backups,
      }),
    ).rejects.toThrow("UNSAFE_DATA_ROOT");
    await expect(
      restoreLocalBackup({ authority: data.authority, backupId: "../escape" }),
    ).rejects.toThrow("INVALID_BACKUP_ID");

    const outside = await mkdtemp(join(tmpdir(), "qali-recovery-outside-"));
    roots.push(outside);
    const linked = join(data.root, "linked-backups");
    await symlink(outside, linked);
    await expect(
      createRecoveryAuthority({
        appData: data.appData,
        namespace: data.namespace,
        root: data.root,
        database: data.database,
        backups: linked,
      }),
    ).rejects.toThrow("UNSAFE_DATA_ROOT");
  });

  test("reset creates a verified backup, deletes exact records, and quarantines only Qali", async () => {
    const data = await fixture();
    const calls: string[] = [];
    const keychain = new Map(
      QALI_KEYCHAIN_RECORDS.map((record) => [record, `${record}-value`]),
    );
    const result = await resetLocalData({
      authority: data.authority,
      buildMarker: "desktop-schema-v1",
      readKeychainRecord: async (record) => keychain.get(record) ?? null,
      writeKeychainRecord: async (record, value) => {
        keychain.set(record, value);
      },
      deleteKeychainRecord: async (record) => {
        calls.push(`keychain:${record}`);
        keychain.delete(record);
      },
      now: new Date("2026-08-19T11:12:13Z"),
    });

    expect(calls.filter((call) => call.startsWith("keychain:"))).toHaveLength(
      QALI_KEYCHAIN_RECORDS.length,
    );
    expect(keychain.size).toBe(0);
    expect(await realpath(result.quarantinePath)).toBe(result.quarantinePath);
    expect(result.quarantinePath).toStartWith(
      `${data.authority.appData}/Qali Test.quarantine-`,
    );
    await expect(realpath(data.root)).rejects.toThrow();
    await expect(
      readFile(join(result.quarantinePath, "database", "state.db"), "utf8"),
    ).resolves.toBe("calendar-v1");
    const manifest = JSON.parse(
      await readFile(
        join(
          result.quarantinePath,
          "backups",
          result.backupId,
          "backup-manifest.json",
        ),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      formatVersion: 2,
      owners: [
        { owner: "database", root: "database" },
        { owner: "settings", root: "config" },
      ],
    });
    await expect(
      readFile(
        join(
          result.quarantinePath,
          "backups",
          result.backupId,
          "config",
          "settings.json",
        ),
        "utf8",
      ),
    ).resolves.toBe('{"theme":"dark","revision":7}\n');
  });

  test("reset leaves the active root selected when backup creation fails", async () => {
    const data = await fixture();
    await rm(data.database, { recursive: true, force: true });
    await expect(
      resetLocalData({
        authority: data.authority,
        buildMarker: "desktop-schema-v1",
        readKeychainRecord: async () => null,
        writeKeychainRecord: async () => {},
        deleteKeychainRecord: async () => {},
      }),
    ).rejects.toThrow();
    await expect(realpath(data.root)).resolves.toBe(data.authority.root);
  });

  test("reset rolls back the quarantine and deleted records when Keychain deletion fails", async () => {
    const data = await fixture();
    const keychain = new Map(
      QALI_KEYCHAIN_RECORDS.map((record) => [record, `${record}-value`]),
    );
    let deletions = 0;
    await expect(
      resetLocalData({
        authority: data.authority,
        buildMarker: "desktop-schema-v1",
        readKeychainRecord: async (record) => keychain.get(record) ?? null,
        writeKeychainRecord: async (record, value) => {
          keychain.set(record, value);
        },
        deleteKeychainRecord: async (record) => {
          deletions += 1;
          if (deletions === 3) throw new Error("keychain failed");
          keychain.delete(record);
        },
        now: new Date("2026-08-19T11:12:14Z"),
      }),
    ).rejects.toThrow("keychain failed");
    expect(Object.fromEntries(keychain)).toEqual(
      Object.fromEntries(
        QALI_KEYCHAIN_RECORDS.map((record) => [record, `${record}-value`]),
      ),
    );
    await expect(realpath(data.root)).resolves.toBe(data.authority.root);
  });

  test("reset leaves Keychain untouched when quarantine cannot be created", async () => {
    const data = await fixture();
    const now = new Date("2026-08-19T11:12:15Z");
    const occupied = join(
      data.appData,
      "Qali Test.quarantine-20260819T111215000Z",
    );
    await mkdir(occupied);
    await writeFile(join(occupied, "occupied"), "do not replace");
    let keychainCalls = 0;
    await expect(
      resetLocalData({
        authority: data.authority,
        buildMarker: "desktop-schema-v1",
        readKeychainRecord: async () => {
          keychainCalls += 1;
          return null;
        },
        writeKeychainRecord: async () => {
          keychainCalls += 1;
        },
        deleteKeychainRecord: async () => {
          keychainCalls += 1;
        },
        now,
      }),
    ).rejects.toThrow();
    expect(keychainCalls).toBe(0);
    await expect(realpath(data.root)).resolves.toBe(data.authority.root);
  });

  test("reset keeps data quarantined instead of exposing an active root with partial credentials", async () => {
    const data = await fixture();
    const now = new Date("2026-08-19T11:12:16Z");
    const quarantine = join(
      data.appData,
      "Qali Test.quarantine-20260819T111216000Z",
    );
    let deletions = 0;
    await expect(
      resetLocalData({
        authority: data.authority,
        buildMarker: "desktop-schema-v1",
        readKeychainRecord: async (record) => `${record}-value`,
        writeKeychainRecord: async () => {
          throw new Error("keychain restore failed");
        },
        deleteKeychainRecord: async () => {
          deletions += 1;
          if (deletions === 2) throw new Error("keychain delete failed");
        },
        now,
      }),
    ).rejects.toThrow("RESET_ROLLBACK_FAILED");
    await expect(realpath(data.root)).rejects.toThrow();
    await expect(
      readFile(join(quarantine, "database", "state.db"), "utf8"),
    ).resolves.toBe("calendar-v1");
  });
});
