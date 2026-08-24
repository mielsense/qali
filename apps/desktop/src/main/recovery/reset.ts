import { lstat, rename } from "node:fs/promises";
import { join } from "node:path";

import { createColdBackup } from "../convex/backup";
import {
  QALI_KEYCHAIN_RECORDS,
  type QaliKeychainRecord,
} from "../keychain/keychain";
import type { RecoveryAuthority } from "./restore";

function quarantineStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

export async function resetLocalData(input: Readonly<{
  authority: RecoveryAuthority;
  buildMarker: string;
  readKeychainRecord(record: QaliKeychainRecord): Promise<string | null>;
  writeKeychainRecord(record: QaliKeychainRecord, value: string): Promise<void>;
  deleteKeychainRecord(record: QaliKeychainRecord): Promise<void>;
  now?: Date;
}>): Promise<Readonly<{
  backupId: string;
  quarantinePath: string;
}>> {
  const now = input.now ?? new Date();
  // Completeness is verified inside createColdBackup before any credential or
  // root mutation is attempted.
  const backup = await createColdBackup({
    root: input.authority.root,
    database: input.authority.database,
    config: join(input.authority.root, "config"),
    backups: input.authority.backups,
  }, input.buildMarker, now);
  const quarantinePath = join(
    input.authority.appData,
    `${input.authority.namespace}.quarantine-${quarantineStamp(now)}`,
  );
  if (await lstat(quarantinePath).then(() => true).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  })) {
    throw new Error("RESET_QUARANTINE_EXISTS");
  }
  await rename(input.authority.root, quarantinePath);
  const values = new Map<QaliKeychainRecord, string | null>();
  try {
    for (const record of QALI_KEYCHAIN_RECORDS) {
      values.set(record, await input.readKeychainRecord(record));
    }
    for (const record of QALI_KEYCHAIN_RECORDS) {
      await input.deleteKeychainRecord(record);
    }
  } catch (error) {
    let rollbackError: unknown;
    for (const record of QALI_KEYCHAIN_RECORDS) {
      const value = values.get(record);
      if (value === undefined || value === null) continue;
      try {
        await input.writeKeychainRecord(record, value);
      } catch (restoreError) {
        rollbackError ??= restoreError;
      }
    }
    if (!rollbackError) {
      try {
        await rename(quarantinePath, input.authority.root);
      } catch (restoreError) {
        rollbackError = restoreError;
      }
    }
    if (rollbackError) {
      throw new Error("RESET_ROLLBACK_FAILED", { cause: rollbackError });
    }
    throw error;
  }
  return Object.freeze({ backupId: backup.id, quarantinePath });
}
