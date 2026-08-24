import { createHash } from "node:crypto";

import type { QaliKeychainRecord } from "../keychain/keychain";

const GOOGLE_ACCOUNT_NAMESPACE = "qali/google-account/v1\0";

export type GoogleCredentialKeychain = Readonly<{
  delete(account: QaliKeychainRecord): Promise<void>;
  get(account: QaliKeychainRecord): Promise<string | null>;
  set(account: QaliKeychainRecord, value: string): Promise<void>;
}>;

export type GoogleAccountMetadata = Readonly<{
  email: string;
  subject: string;
}>;

export type StoredGoogleConnection = Readonly<{
  account: GoogleAccountMetadata;
  refreshToken: string;
}>;

export type StoredGoogleAccount = StoredGoogleConnection &
  Readonly<{
    accountId: string;
    slot: GoogleAccountSlotRecord;
  }>;

export type LegacyGoogleCredentialCandidate = Readonly<{
  accountSource: string;
  clientSource: string | null;
  connection: StoredGoogleConnection;
  refreshTokenSource: string;
}>;

export type LegacyGoogleCredentialSnapshot = Readonly<{
  accountSource: string | null;
  clientSource: string | null;
  refreshTokenSource: string | null;
}>;

export type LegacyCleanupResult = "complete" | "cleanup-deferred";

export type LegacyGoogleCredentialInspection =
  | Readonly<{ kind: "not-needed" }>
  | Readonly<{ kind: "client-mismatch" }>
  | Readonly<{
      kind: "incomplete-or-corrupt";
      knownAccount: GoogleAccountMetadata | null;
      recovery: "disconnect" | "reconnect";
      snapshot: LegacyGoogleCredentialSnapshot;
    }>
  | Readonly<{
      candidate: LegacyGoogleCredentialCandidate;
      kind: "candidate";
    }>;

export const GOOGLE_ACCOUNT_LIMIT = 8;
export const GOOGLE_ACCOUNT_SLOT_RECORDS = [
  "google-account-v2-0",
  "google-account-v2-1",
  "google-account-v2-2",
  "google-account-v2-3",
  "google-account-v2-4",
  "google-account-v2-5",
  "google-account-v2-6",
  "google-account-v2-7",
] as const satisfies readonly QaliKeychainRecord[];
export type GoogleAccountSlotRecord =
  (typeof GOOGLE_ACCOUNT_SLOT_RECORDS)[number];

const LEGACY_GOOGLE_RECORDS = [
  "google-refresh-token",
  "google-account-metadata",
  "google-oauth-client-config",
] as const satisfies readonly QaliKeychainRecord[];
const LEGACY_GOOGLE_RECORD = "google-oauth-client-config" as const;
const MAX_STORED_VALUE_LENGTH = 16 * 1024;

function corrupt(): Error {
  return new Error("GOOGLE_CREDENTIALS_CORRUPT");
}

function parseRecord(source: string): Record<string, unknown> {
  if (source.length < 2 || source.length > MAX_STORED_VALUE_LENGTH)
    throw corrupt();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw corrupt();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw corrupt();
  return value as Record<string, unknown>;
}

function validEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validRefreshToken(value: string): boolean {
  return value.length >= 1 && value.length <= 8_192;
}

function parseAccount(accountSource: string): GoogleAccountMetadata {
  const account = parseRecord(accountSource);
  if (
    account.version !== 1 ||
    typeof account.email !== "string" ||
    !validEmail(account.email) ||
    typeof account.subject !== "string" ||
    account.subject.length < 1 ||
    account.subject.length > 256
  ) {
    throw corrupt();
  }
  return Object.freeze({ email: account.email, subject: account.subject });
}

function parseConnection(
  refreshToken: string,
  accountSource: string,
): StoredGoogleConnection {
  if (!validRefreshToken(refreshToken)) throw corrupt();
  return Object.freeze({
    account: parseAccount(accountSource),
    refreshToken,
  });
}

function parseLegacyClientId(source: string): string {
  const value = parseRecord(source);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "clientId" ||
    keys[1] !== "clientSecret" ||
    keys[2] !== "version" ||
    value.version !== 1 ||
    typeof value.clientId !== "string" ||
    value.clientId.length < 1 ||
    value.clientId.length > 256
  ) {
    throw corrupt();
  }
  return value.clientId;
}

export function googleAccountId(subject: string): string {
  if (subject.length < 1 || subject.length > 256) throw corrupt();
  return `gacc_${createHash("sha256")
    .update(`${GOOGLE_ACCOUNT_NAMESPACE}${subject}`, "utf8")
    .digest("base64url")}`;
}

/** Compatibility for the first multi-account build, which hashed the raw
 * Google subject before the cross-layer namespace was frozen. This is not a
 * second accepted identity: callers always receive the current canonical ID,
 * and the next verified save rewrites the slot in the current format. */
function firstMultiAccountReleaseId(subject: string): string {
  return `gacc_${createHash("sha256")
    .update(subject, "utf8")
    .digest("base64url")}`;
}

function serializeAccount(connection: StoredGoogleConnection): string {
  if (
    !validEmail(connection.account.email) ||
    connection.account.subject.length < 1 ||
    connection.account.subject.length > 256 ||
    !validRefreshToken(connection.refreshToken)
  ) {
    throw corrupt();
  }
  return JSON.stringify({
    accountId: googleAccountId(connection.account.subject),
    email: connection.account.email,
    refreshToken: connection.refreshToken,
    subject: connection.account.subject,
    version: 2,
  });
}

function parseV2Account(
  source: string,
  slot: GoogleAccountSlotRecord,
): StoredGoogleAccount {
  const value = parseRecord(source);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "accountId" ||
    keys[1] !== "email" ||
    keys[2] !== "refreshToken" ||
    keys[3] !== "subject" ||
    keys[4] !== "version" ||
    value.version !== 2 ||
    typeof value.email !== "string" ||
    !validEmail(value.email) ||
    typeof value.subject !== "string" ||
    value.subject.length < 1 ||
    value.subject.length > 256 ||
    typeof value.refreshToken !== "string" ||
    !validRefreshToken(value.refreshToken) ||
    typeof value.accountId !== "string" ||
    (value.accountId !== googleAccountId(value.subject) &&
      value.accountId !== firstMultiAccountReleaseId(value.subject))
  ) {
    throw corrupt();
  }
  return Object.freeze({
    account: Object.freeze({ email: value.email, subject: value.subject }),
    accountId: googleAccountId(value.subject),
    refreshToken: value.refreshToken,
    slot,
  });
}

export class GoogleTokenStore {
  constructor(private readonly keychain: GoogleCredentialKeychain) {}

  async list(): Promise<readonly StoredGoogleAccount[]> {
    const sources = await Promise.all(
      GOOGLE_ACCOUNT_SLOT_RECORDS.map((slot) => this.keychain.get(slot)),
    );
    const accounts: StoredGoogleAccount[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (source == null) continue;
      const account = parseV2Account(
        source,
        GOOGLE_ACCOUNT_SLOT_RECORDS[index]!,
      );
      if (ids.has(account.accountId)) throw corrupt();
      ids.add(account.accountId);
      accounts.push(account);
    }
    return Object.freeze(accounts);
  }

  async load(
    accountId?: string,
  ): Promise<StoredGoogleAccount | StoredGoogleConnection | null> {
    const accounts = await this.list();
    if (accountId !== undefined) {
      return (
        accounts.find((account) => account.accountId === accountId) ?? null
      );
    }
    if (accounts.length > 1) throw new Error("GOOGLE_ACCOUNT_ID_REQUIRED");
    if (accounts.length === 1) return accounts[0]!;
    return await this.#loadLegacyTuple();
  }

  async loadAccount(accountId: string): Promise<StoredGoogleAccount | null> {
    if (!/^gacc_[A-Za-z0-9_-]{43}$/.test(accountId)) throw corrupt();
    return (
      (await this.list()).find((account) => account.accountId === accountId) ??
      null
    );
  }

  async save(connection: StoredGoogleConnection): Promise<StoredGoogleAccount> {
    const source = serializeAccount(connection);
    const accountId = googleAccountId(connection.account.subject);
    const accounts = await this.list();
    const existing = accounts.find(
      (account) => account.accountId === accountId,
    );
    let slot = existing?.slot;
    if (!slot) {
      const occupied = new Set(accounts.map((account) => account.slot));
      slot = GOOGLE_ACCOUNT_SLOT_RECORDS.find(
        (candidate) => !occupied.has(candidate),
      );
    }
    if (!slot) throw new Error("GOOGLE_ACCOUNT_LIMIT_REACHED");

    await this.keychain.set(slot, source);
    const verified = await this.keychain.get(slot);
    if (verified !== source) throw new Error("GOOGLE_CREDENTIAL_SAVE_FAILED");
    return parseV2Account(verified, slot);
  }

  async replaceRefreshToken(
    accountId: string,
    refreshToken: string,
  ): Promise<StoredGoogleAccount> {
    if (!validRefreshToken(refreshToken)) {
      throw new Error("GOOGLE_REFRESH_TOKEN_SAVE_FAILED");
    }
    const prior = await this.loadAccount(accountId);
    if (!prior) throw corrupt();
    try {
      return await this.save({ account: prior.account, refreshToken });
    } catch {
      throw new Error("GOOGLE_REFRESH_TOKEN_SAVE_FAILED");
    }
  }

  async deleteAccount(accountId: string): Promise<void> {
    const stored = await this.loadAccount(accountId);
    if (!stored) return;
    await this.keychain.delete(stored.slot);
    if ((await this.keychain.get(stored.slot)) !== null) {
      throw new Error("GOOGLE_CREDENTIAL_DELETE_FAILED");
    }
  }

  async inspectLegacy(
    packagedClientId: string,
  ): Promise<LegacyGoogleCredentialInspection> {
    const [clientSource, refreshTokenSource, accountSource] = await Promise.all(
      [
        this.keychain.get(LEGACY_GOOGLE_RECORD),
        this.keychain.get("google-refresh-token"),
        this.keychain.get("google-account-metadata"),
      ],
    );
    let knownAccount: GoogleAccountMetadata | null = null;
    if (accountSource !== null) {
      try {
        knownAccount = parseAccount(accountSource);
      } catch {
        // Malformed identity cannot authorize an in-place replacement.
      }
    }
    const incomplete = (
      recovery: "disconnect" | "reconnect",
    ): LegacyGoogleCredentialInspection => ({
      kind: "incomplete-or-corrupt",
      knownAccount,
      recovery,
      snapshot: Object.freeze({
        accountSource,
        clientSource,
        refreshTokenSource,
      }),
    });
    if (clientSource === null) {
      if (refreshTokenSource === null && accountSource === null)
        return { kind: "not-needed" };
      if (refreshTokenSource !== null && accountSource !== null) {
        try {
          return {
            candidate: Object.freeze({
              accountSource,
              clientSource: null,
              connection: parseConnection(refreshTokenSource, accountSource),
              refreshTokenSource,
            }),
            kind: "candidate",
          };
        } catch {
          // Continue to bounded partial-state recovery.
        }
      }
      return incomplete(knownAccount ? "reconnect" : "disconnect");
    }
    let legacyClientId: string;
    try {
      legacyClientId = parseLegacyClientId(clientSource);
    } catch {
      return incomplete("disconnect");
    }
    if (legacyClientId !== packagedClientId) return { kind: "client-mismatch" };
    if (refreshTokenSource === null || accountSource === null) {
      return incomplete(knownAccount ? "reconnect" : "disconnect");
    }
    try {
      return {
        candidate: Object.freeze({
          accountSource,
          clientSource,
          connection: parseConnection(refreshTokenSource, accountSource),
          refreshTokenSource,
        }),
        kind: "candidate",
      };
    } catch {
      return incomplete(knownAccount ? "reconnect" : "disconnect");
    }
  }

  async legacyMarkerMatchesClient(packagedClientId: string): Promise<boolean> {
    const source = await this.keychain.get(LEGACY_GOOGLE_RECORD);
    if (source === null) return true;
    try {
      return parseLegacyClientId(source) === packagedClientId;
    } catch {
      return false;
    }
  }

  async completeLegacyMigration(
    candidate: LegacyGoogleCredentialCandidate,
    replacementRefreshToken?: string,
  ): Promise<LegacyCleanupResult> {
    await this.#assertLegacySnapshot({
      accountSource: candidate.accountSource,
      clientSource: candidate.clientSource,
      refreshTokenSource: candidate.refreshTokenSource,
    });
    const accountId = googleAccountId(candidate.connection.account.subject);
    const existing = await this.loadAccount(accountId);
    const refreshToken =
      existing && existing.refreshToken !== candidate.connection.refreshToken
        ? existing.refreshToken
        : (replacementRefreshToken ?? candidate.connection.refreshToken);
    await this.save({
      account: existing?.account ?? candidate.connection.account,
      refreshToken,
    });
    return await this.#clearLegacy();
  }

  async replaceIncompleteLegacy(
    snapshot: LegacyGoogleCredentialSnapshot,
    connection: StoredGoogleConnection,
  ): Promise<LegacyCleanupResult> {
    await this.#assertLegacySnapshot(snapshot);
    await this.save(connection);
    return await this.#clearLegacy();
  }

  async loadForClient(
    packagedClientId: string,
  ): Promise<StoredGoogleConnection> {
    const inspected = await this.inspectLegacy(packagedClientId);
    if (
      inspected.kind === "client-mismatch" ||
      (inspected.kind === "incomplete-or-corrupt" &&
        inspected.recovery === "disconnect")
    ) {
      throw corrupt();
    }
    const loaded = await this.load();
    if (loaded) return loaded;
    if (inspected.kind === "candidate") return inspected.candidate.connection;
    throw corrupt();
  }

  async inspectForDisconnect(accountId?: string): Promise<
    Readonly<{
      hasCredentials: boolean;
      hasLegacyCredentials: boolean;
      refreshTokens: readonly string[];
    }>
  > {
    if (accountId !== undefined) {
      const account = await this.loadAccount(accountId);
      return Object.freeze({
        hasCredentials: account !== null,
        hasLegacyCredentials: false,
        refreshTokens: Object.freeze(account ? [account.refreshToken] : []),
      });
    }
    const [clientSource, refreshToken, accountSource, accounts] =
      await Promise.all([
        this.keychain.get(LEGACY_GOOGLE_RECORD),
        this.keychain.get("google-refresh-token"),
        this.keychain.get("google-account-metadata"),
        this.list(),
      ]);
    const hasLegacyCredentials =
      clientSource !== null || refreshToken !== null || accountSource !== null;
    const refreshTokens = new Set<string>();
    if (hasLegacyCredentials) {
      for (const account of accounts) refreshTokens.add(account.refreshToken);
      if (validRefreshToken(refreshToken ?? ""))
        refreshTokens.add(refreshToken!);
    }
    return Object.freeze({
      hasCredentials: accounts.length > 0 || hasLegacyCredentials,
      hasLegacyCredentials,
      refreshTokens: Object.freeze([...refreshTokens]),
    });
  }

  async completeVerifiedReconnect(
    accountSubject: string,
  ): Promise<LegacyCleanupResult> {
    const account = await this.loadAccount(googleAccountId(accountSubject));
    if (!account) throw new Error("GOOGLE_CREDENTIAL_MIGRATION_CHANGED");
    return await this.#clearLegacy();
  }

  async clear(accountId?: string): Promise<void> {
    if (accountId !== undefined) {
      await this.deleteAccount(accountId);
      return;
    }
    const results = await Promise.allSettled(
      [...GOOGLE_ACCOUNT_SLOT_RECORDS, ...LEGACY_GOOGLE_RECORDS].map((record) =>
        this.keychain.delete(record),
      ),
    );
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("GOOGLE_CREDENTIAL_DELETE_FAILED");
    }
  }

  async #loadLegacyTuple(): Promise<StoredGoogleConnection | null> {
    const [clientSource, refreshToken, accountSource] = await Promise.all([
      this.keychain.get(LEGACY_GOOGLE_RECORD),
      this.keychain.get("google-refresh-token"),
      this.keychain.get("google-account-metadata"),
    ]);
    if (
      refreshToken === null &&
      accountSource === null &&
      clientSource === null
    )
      return null;
    if (refreshToken === null || accountSource === null) throw corrupt();
    if (clientSource !== null) parseLegacyClientId(clientSource);
    return parseConnection(refreshToken, accountSource);
  }

  async #assertLegacySnapshot(
    snapshot: LegacyGoogleCredentialSnapshot,
  ): Promise<void> {
    const [clientSource, refreshTokenSource, accountSource] = await Promise.all(
      [
        this.keychain.get(LEGACY_GOOGLE_RECORD),
        this.keychain.get("google-refresh-token"),
        this.keychain.get("google-account-metadata"),
      ],
    );
    if (
      clientSource !== snapshot.clientSource ||
      refreshTokenSource !== snapshot.refreshTokenSource ||
      accountSource !== snapshot.accountSource
    ) {
      throw new Error("GOOGLE_CREDENTIAL_MIGRATION_CHANGED");
    }
  }

  async #clearLegacy(): Promise<LegacyCleanupResult> {
    const results = await Promise.allSettled(
      LEGACY_GOOGLE_RECORDS.map((record) => this.keychain.delete(record)),
    );
    return results.every((result) => result.status === "fulfilled")
      ? "complete"
      : "cleanup-deferred";
  }
}
