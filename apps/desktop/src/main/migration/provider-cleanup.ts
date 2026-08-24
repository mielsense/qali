const MAX_MIGRATION_PAGES = 100;
const MAX_CURSOR_BYTES = 8_192;

type CleanupPage = Readonly<{
  done: boolean;
  cursor?: string;
  cleared?: number;
}>;

type ProviderMigrationInput = Readonly<{
  googleStatus(): Promise<Readonly<{ kind: string }>>;
  cleanupPage(cursor?: string): Promise<CleanupPage>;
  completeMigration(): Promise<void>;
}>;

type DeferredMigrationReason =
  | "cleanup-failed"
  | "disconnected"
  | "migration-failed"
  | "stopped";

type DeferredMigration = Readonly<{
  kind: "deferred";
  reason: DeferredMigrationReason;
}>;

type CompletedMigration = Readonly<{ kind: "completed"; cleared: number }>;

export type ProviderMigrationResult = DeferredMigration | CompletedMigration;

/**
 * Remove obsolete backend credential references only after the Google broker
 * proves that its account is backed by the app's Keychain records.
 */
export async function cleanupLegacyProviderReferences(input: Readonly<{
  googleStatus(): Promise<Readonly<{ kind: string }>>;
  cleanupPage(cursor?: string): Promise<CleanupPage>;
}>): Promise<DeferredMigration | CompletedMigration> {
  if ((await input.googleStatus()).kind !== "connected") {
    return { kind: "deferred", reason: "disconnected" };
  }
  let cursor: string | undefined;
  let cleared = 0;
  const seen = new Set<string>();
  for (let pageCount = 0; pageCount < MAX_MIGRATION_PAGES; pageCount += 1) {
    const page = await input.cleanupPage(cursor);
    if (!Number.isSafeInteger(page.cleared ?? 0) || (page.cleared ?? 0) < 0) {
      throw new Error("MIGRATION_RESULT_INVALID");
    }
    cleared += page.cleared ?? 0;
    if (page.done) return { kind: "completed", cleared };
    if (
      !page.cursor ||
      Buffer.byteLength(page.cursor, "utf8") > MAX_CURSOR_BYTES ||
      seen.has(page.cursor)
    ) {
      throw new Error("MIGRATION_CURSOR_REPEATED");
    }
    seen.add(page.cursor);
    cursor = page.cursor;
  }
  throw new Error("MIGRATION_PAGE_LIMIT");
}

async function runLegacyProviderMigration(
  input: ProviderMigrationInput,
  isStopped: () => boolean = () => false,
): Promise<ProviderMigrationResult> {
  if (isStopped()) return { kind: "deferred", reason: "stopped" };

  let cleanup: DeferredMigration | CompletedMigration;
  try {
    cleanup = await cleanupLegacyProviderReferences(input);
  } catch {
    return { kind: "deferred", reason: "cleanup-failed" };
  }
  if (cleanup.kind === "deferred") return cleanup;
  if (isStopped()) return { kind: "deferred", reason: "stopped" };
  try {
    await input.completeMigration();
  } catch {
    return { kind: "deferred", reason: "migration-failed" };
  }
  if (isStopped()) return { kind: "deferred", reason: "stopped" };
  return cleanup;
}

export async function requireLegacyProviderMigration(
  input: ProviderMigrationInput,
): Promise<CompletedMigration> {
  const result = await runLegacyProviderMigration(input);
  if (result.kind === "deferred") {
    throw new Error("RESTORE_MIGRATION_DEFERRED");
  }
  return result;
}

export class LegacyProviderMigrationCoordinator {
  #completed: CompletedMigration | null = null;
  #inFlight: Promise<ProviderMigrationResult> | null = null;
  #stopped = false;
  #stopPromise: Promise<void> | null = null;

  constructor(private readonly input: ProviderMigrationInput) {}

  resume(): Promise<ProviderMigrationResult> {
    if (this.#stopped) {
      return Promise.resolve({ kind: "deferred", reason: "stopped" });
    }
    if (this.#completed) return Promise.resolve(this.#completed);
    if (this.#inFlight) return this.#inFlight;
    const migration = runLegacyProviderMigration(this.input, () => this.#stopped)
      .then((result) => {
        if (result.kind === "completed") this.#completed = result;
        return result;
      })
      .finally(() => {
        if (this.#inFlight === migration) this.#inFlight = null;
      });
    this.#inFlight = migration;
    return migration;
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#stopPromise = (this.#inFlight ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    );
    return this.#stopPromise;
  }
}
