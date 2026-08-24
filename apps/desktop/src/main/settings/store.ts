import {
  legacySettingsImportRequestSchema,
  settingsPatchRequestSchema,
  settingsResetRequestSchema,
  type LegacySettingsImportRequest,
  type QaliSettingsDocument,
  type SettingsPatchRequest,
  type SettingsResetRequest,
  type SettingsResetTarget,
  type SettingsSnapshot,
  type SettingsWriteResult,
} from "@qali/desktop-contracts/schemas";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  createDefaultSettings,
  mergeSettingsChanges,
  parseSettingsDocument,
  withSettingsRevision,
} from "./schema";
import { canonicalizeTimeZone, canonicalizeTimeZones } from "./time-zones";

const SETTINGS_FILE_NAME = "settings.json";
const MAX_OPERATION_RECEIPTS = 128;

type SettingsOperationReceipt = Readonly<{
  operationId: string;
  snapshot: SettingsSnapshot;
}>;

type StoredSettingsFile = Readonly<{
  settings: QaliSettingsDocument;
  internal: {
    operationReceipts: readonly SettingsOperationReceipt[];
    legacyImports: { calendarPreferencesV1: boolean; viteUiTheme: boolean };
  };
}>;

export interface SettingsStore {
  snapshot(): SettingsSnapshot;
  patch(input: SettingsPatchRequest): Promise<SettingsWriteResult>;
  reset(input: SettingsResetRequest): Promise<SettingsWriteResult>;
  importLegacy(
    input: LegacySettingsImportRequest,
  ): Promise<SettingsWriteResult>;
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const operationReceiptSchema = z
  .object({
    operationId: z.string().min(1).max(128),
    snapshot: z.object({ settings: z.unknown() }).strict(),
  })
  .strict();

const storedSettingsFileEnvelopeSchema = z
  .object({
    settings: z.unknown(),
    internal: z
      .object({
        operationReceipts: z
          .array(operationReceiptSchema)
          .max(MAX_OPERATION_RECEIPTS),
        legacyImports: z
          .object({
            calendarPreferencesV1: z.boolean(),
            viteUiTheme: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

function freezeSnapshot(settings: QaliSettingsDocument): SettingsSnapshot {
  return Object.freeze({ settings });
}

function parseStoredSettingsFile(value: unknown): StoredSettingsFile {
  const envelope = storedSettingsFileEnvelopeSchema.parse(value);
  const settings = parseSettingsDocument(envelope.settings);
  const operationReceipts = envelope.internal.operationReceipts.map((receipt) =>
    Object.freeze({
      operationId: receipt.operationId,
      snapshot: freezeSnapshot(
        parseSettingsDocument(receipt.snapshot.settings),
      ),
    }),
  );
  return Object.freeze({
    settings,
    internal: Object.freeze({
      operationReceipts: Object.freeze(operationReceipts),
      legacyImports: Object.freeze({ ...envelope.internal.legacyImports }),
    }),
  });
}

function makeStoredSettingsFile(
  settings: QaliSettingsDocument,
  operationReceipts: readonly SettingsOperationReceipt[],
  legacyImports: StoredSettingsFile["internal"]["legacyImports"],
): StoredSettingsFile {
  return Object.freeze({
    settings,
    internal: Object.freeze({
      operationReceipts: Object.freeze([...operationReceipts]),
      legacyImports: Object.freeze({ ...legacyImports }),
    }),
  });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeStoredSettingsFile(
  configRoot: string,
  settingsPath: string,
  value: StoredSettingsFile,
): Promise<void> {
  const temporaryPath = join(
    configRoot,
    `.${SETTINGS_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, settingsPath);
    await syncDirectory(configRoot);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function detectQuarantineReason(value: unknown): "future" | "corrupt" {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "settings" in value
  ) {
    const settings = (value as { settings?: unknown }).settings;
    if (
      settings &&
      typeof settings === "object" &&
      !Array.isArray(settings) &&
      typeof (settings as { schemaVersion?: unknown }).schemaVersion ===
        "number" &&
      (settings as { schemaVersion: number }).schemaVersion > 2
    ) {
      return "future";
    }
  }
  return "corrupt";
}

async function quarantineSettingsFile(
  configRoot: string,
  settingsPath: string,
  reason: "future" | "corrupt",
): Promise<void> {
  const quarantinePath = `${settingsPath}.quarantine-${reason}-${Date.now()}-${randomUUID()}`;
  await rename(settingsPath, quarantinePath);
  await chmod(quarantinePath, 0o600);
  await syncDirectory(configRoot);
}

async function loadOrCreateStoredSettings(
  configRoot: string,
  settingsPath: string,
  systemTimeZone: string,
): Promise<StoredSettingsFile> {
  let serialized: string;
  try {
    serialized = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const created = makeStoredSettingsFile(
      createDefaultSettings(systemTimeZone),
      [],
      { calendarPreferencesV1: false, viteUiTheme: false },
    );
    await writeStoredSettingsFile(configRoot, settingsPath, created);
    return created;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
    return parseStoredSettingsFile(decoded);
  } catch {
    await quarantineSettingsFile(
      configRoot,
      settingsPath,
      detectQuarantineReason(decoded),
    );
    const replacement = makeStoredSettingsFile(
      createDefaultSettings(systemTimeZone),
      [],
      { calendarPreferencesV1: false, viteUiTheme: false },
    );
    await writeStoredSettingsFile(configRoot, settingsPath, replacement);
    return replacement;
  }
}

function normalizePatchRequest(
  input: SettingsPatchRequest,
): SettingsPatchRequest {
  const changes = input?.changes;
  const calendar = changes?.calendar;
  const normalized = calendar
    ? {
        ...input,
        changes: {
          ...changes,
          calendar: {
            ...calendar,
            ...(calendar.primaryTimeZone === undefined
              ? {}
              : {
                  primaryTimeZone: canonicalizeTimeZone(
                    calendar.primaryTimeZone,
                  ),
                }),
            ...(calendar.secondaryTimeZones === undefined
              ? {}
              : {
                  secondaryTimeZones: canonicalizeTimeZones(
                    calendar.secondaryTimeZones,
                  ),
                }),
          },
        },
      }
    : input;
  return settingsPatchRequestSchema.parse(normalized) as SettingsPatchRequest;
}

function resetChanges(
  defaults: QaliSettingsDocument,
  target: SettingsResetTarget,
): SettingsPatchRequest["changes"] {
  if (target === "calendar") return { calendar: defaults.calendar };
  if (target === "appearance") return { appearance: defaults.appearance };
  if (target === "keybindings") return { keybindings: { overrides: {} } };

  const [section, key] = target.split(".") as [
    "calendar" | "appearance",
    string,
  ];
  if (section === "calendar") {
    const calendarKey = key as keyof QaliSettingsDocument["calendar"];
    return { calendar: { [calendarKey]: defaults.calendar[calendarKey] } };
  }
  const appearanceKey = key as keyof QaliSettingsDocument["appearance"];
  return {
    appearance: { [appearanceKey]: defaults.appearance[appearanceKey] },
  };
}

function mapLegacyHourHeight(hourHeight: number): 72 | 96 | undefined {
  if (hourHeight === 64) return 72;
  if (hourHeight === 80 || hourHeight === 96) return 96;
  return undefined;
}

export async function openSettingsStore(
  input: Readonly<{
    configRoot: string;
    systemTimeZone: string;
  }>,
): Promise<SettingsStore> {
  await mkdir(input.configRoot, { recursive: true, mode: 0o700 });
  await chmod(input.configRoot, 0o700);
  const settingsPath = join(input.configRoot, SETTINGS_FILE_NAME);
  let stored = await loadOrCreateStoredSettings(
    input.configRoot,
    settingsPath,
    input.systemTimeZone,
  );
  const defaults = createDefaultSettings(
    stored.settings.calendar.primaryTimeZone,
  );
  const listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const currentSnapshot = (): SettingsSnapshot =>
    freezeSnapshot(stored.settings);

  const findReceipt = (
    operationId: string,
  ): SettingsOperationReceipt | undefined =>
    stored.internal.operationReceipts.find(
      (receipt) => receipt.operationId === operationId,
    );

  const commit = async (
    operationId: string,
    nextSettings: QaliSettingsDocument,
    legacyImports = stored.internal.legacyImports,
  ): Promise<SettingsWriteResult> => {
    const snapshot = freezeSnapshot(nextSettings);
    const receipt = Object.freeze({ operationId, snapshot });
    const receipts = [...stored.internal.operationReceipts, receipt].slice(
      -MAX_OPERATION_RECEIPTS,
    );
    const nextStored = makeStoredSettingsFile(
      nextSettings,
      receipts,
      legacyImports,
    );
    await writeStoredSettingsFile(input.configRoot, settingsPath, nextStored);
    stored = nextStored;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A renderer listener cannot roll back or invalidate an already durable commit.
      }
    }
    return { kind: "committed", snapshot };
  };

  const assertOpen = (): void => {
    if (closed) throw new Error("SETTINGS_STORE_CLOSED");
  };

  const store: SettingsStore = {
    snapshot: currentSnapshot,

    patch(request) {
      return enqueue(async () => {
        assertOpen();
        const parsed = normalizePatchRequest(request);
        const replay = findReceipt(parsed.operationId);
        if (replay) return { kind: "replayed", snapshot: replay.snapshot };
        if (parsed.baseRevision !== stored.settings.revision) {
          return { kind: "revision-conflict", snapshot: currentSnapshot() };
        }
        const merged = mergeSettingsChanges(stored.settings, parsed.changes);
        return commit(
          parsed.operationId,
          withSettingsRevision(merged, stored.settings.revision + 1),
        );
      });
    },

    reset(request) {
      return enqueue(async () => {
        assertOpen();
        const parsed = settingsResetRequestSchema.parse(
          request,
        ) as SettingsResetRequest;
        const replay = findReceipt(parsed.operationId);
        if (replay) return { kind: "replayed", snapshot: replay.snapshot };
        if (parsed.baseRevision !== stored.settings.revision) {
          return { kind: "revision-conflict", snapshot: currentSnapshot() };
        }
        const merged =
          parsed.target === "keybindings"
            ? parseSettingsDocument({
                ...stored.settings,
                keybindings: defaults.keybindings,
              })
            : mergeSettingsChanges(
                stored.settings,
                resetChanges(defaults, parsed.target),
              );
        return commit(
          parsed.operationId,
          withSettingsRevision(merged, stored.settings.revision + 1),
        );
      });
    },

    importLegacy(request) {
      return enqueue(async () => {
        assertOpen();
        const parsed = legacySettingsImportRequestSchema.parse(
          request,
        ) as LegacySettingsImportRequest;
        const replay = findReceipt(parsed.operationId);
        if (replay) return { kind: "replayed", snapshot: replay.snapshot };

        const changes: {
          calendar?: Record<string, unknown>;
          appearance?: Record<string, unknown>;
        } = {};
        const legacyImports = { ...stored.internal.legacyImports };

        if (
          parsed.calendarPreferencesV1 &&
          !legacyImports.calendarPreferencesV1
        ) {
          const legacy = parsed.calendarPreferencesV1;
          const calendar: Record<string, unknown> = {};
          for (const key of [
            "dayStartHour",
            "dayEndHour",
            "defaultView",
          ] as const) {
            if (stored.settings.calendar[key] === defaults.calendar[key]) {
              calendar[key] = legacy[key];
            }
          }
          const mappedDensity = mapLegacyHourHeight(legacy.hourHeight);
          if (
            mappedDensity !== undefined &&
            stored.settings.calendar.hourHeight === defaults.calendar.hourHeight
          ) {
            calendar.hourHeight = mappedDensity;
          }
          if (Object.keys(calendar).length > 0) changes.calendar = calendar;
          legacyImports.calendarPreferencesV1 = true;
        }

        if (parsed.theme && !legacyImports.viteUiTheme) {
          if (stored.settings.appearance.theme === defaults.appearance.theme) {
            changes.appearance = { theme: parsed.theme };
          }
          legacyImports.viteUiTheme = true;
        }

        const merged = mergeSettingsChanges(
          stored.settings,
          changes as SettingsPatchRequest["changes"],
        );
        return commit(
          parsed.operationId,
          withSettingsRevision(merged, stored.settings.revision + 1),
          legacyImports,
        );
      });
    },

    subscribe(listener) {
      assertOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    flush() {
      return tail;
    },

    close() {
      return enqueue(async () => {
        closed = true;
        listeners.clear();
      });
    },
  };

  return Object.freeze(store);
}
