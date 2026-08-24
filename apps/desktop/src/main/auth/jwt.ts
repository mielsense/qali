import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type JsonWebKey,
} from "node:crypto";

import type { KeychainStore } from "../keychain/keychain";

export const LOCAL_JWT_AUDIENCE = "qali-local-convex";
export const LOCAL_JWT_SUBJECT = "qali-local-user";
export const LOCAL_JWT_ALGORITHM = "RS256";

export type LocalJwtRole = "renderer" | "desktop_broker";

type SigningKeyStore = Pick<KeychainStore, "get" | "set">;

export type LocalJwtTokenProvider = Readonly<{
  getToken(options: { forceRefreshToken: boolean }): Promise<string>;
}>;

export type LocalJwtAuthority = Readonly<{
  issuer: string;
  jwks: Readonly<{ keys: readonly JsonWebKey[] }>;
  mintRendererToken(): Promise<string>;
  mintDesktopBrokerToken(): Promise<string>;
  createRendererTokenProvider(): LocalJwtTokenProvider;
  createDesktopBrokerTokenProvider(): LocalJwtTokenProvider;
}>;

type StoredSigningKey = Readonly<{
  version: 1;
  kid: string;
  privateKeyPem: string;
}>;

export type LocalJwtAuthorityOptions = Readonly<{
  issuer: string;
  keychain: SigningKeyStore;
  now?: () => number;
}>;

const TOKEN_LIFETIME_SECONDS = 180;
const REFRESH_WINDOW_SECONDS = 60;
const MAX_STORED_KEY_BYTES = 16 * 1024;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function assertLoopbackIssuer(value: string): void {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new Error("Local JWT issuer must be an exact loopback origin");
  }
  if (
    issuer.protocol !== "http:" ||
    issuer.hostname !== "127.0.0.1" ||
    issuer.port === "" ||
    issuer.pathname !== "/" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.origin !== value
  ) {
    throw new Error("Local JWT issuer must be an exact loopback origin");
  }
}

function publicJwkFor(privateKeyPem: string): JsonWebKey {
  const publicJwk = createPublicKey(createPrivateKey(privateKeyPem)).export({
    format: "jwk",
  });
  if (publicJwk.kty !== "RSA" || !publicJwk.n || !publicJwk.e) {
    throw new Error("Stored local JWT signing key is invalid");
  }
  return publicJwk;
}

function keyIdFor(publicJwk: JsonWebKey): string {
  return createHash("sha256")
    .update(`${publicJwk.kty}:${publicJwk.n}:${publicJwk.e}`)
    .digest("base64url");
}

function parseStoredSigningKey(raw: string): StoredSigningKey {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORED_KEY_BYTES) {
    throw new Error("Stored local JWT signing key is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Stored local JWT signing key is invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "kid,privateKeyPem,version" ||
    (value as Partial<StoredSigningKey>).version !== 1 ||
    typeof (value as Partial<StoredSigningKey>).kid !== "string" ||
    typeof (value as Partial<StoredSigningKey>).privateKeyPem !== "string"
  ) {
    throw new Error("Stored local JWT signing key is invalid");
  }
  const stored = value as StoredSigningKey;
  const publicJwk = publicJwkFor(stored.privateKeyPem);
  if (keyIdFor(publicJwk) !== stored.kid) {
    throw new Error("Stored local JWT signing key is invalid");
  }
  return stored;
}

async function loadOrCreateSigningKey(
  keychain: SigningKeyStore,
): Promise<{ stored: StoredSigningKey; publicJwk: JsonWebKey }> {
  const existing = await keychain.get("local-jwt-signing-key");
  if (existing !== null) {
    const stored = parseStoredSigningKey(existing);
    return { stored, publicJwk: publicJwkFor(stored.privateKeyPem) };
  }

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const privateKeyPem = privateKey
    .export({
      format: "pem",
      type: "pkcs8",
    })
    .toString();
  const publicJwk = publicKey.export({ format: "jwk" });
  const stored: StoredSigningKey = {
    version: 1,
    kid: keyIdFor(publicJwk),
    privateKeyPem,
  };
  await keychain.set("local-jwt-signing-key", JSON.stringify(stored));
  return { stored, publicJwk };
}

export async function createLocalJwtAuthority(
  options: LocalJwtAuthorityOptions,
): Promise<LocalJwtAuthority> {
  assertLoopbackIssuer(options.issuer);
  const now = options.now ?? Date.now;
  const { stored, publicJwk } = await loadOrCreateSigningKey(options.keychain);
  const privateKey = createPrivateKey(stored.privateKeyPem);
  const jwk: JsonWebKey = Object.freeze({
    ...publicJwk,
    alg: LOCAL_JWT_ALGORITHM,
    kid: stored.kid,
    use: "sig",
  });
  const jwks = Object.freeze({ keys: Object.freeze([jwk]) });

  const mint = async (role: LocalJwtRole): Promise<string> => {
    const issuedAt = Math.floor(now() / 1_000);
    const encodedHeader = encodeJson({
      alg: LOCAL_JWT_ALGORITHM,
      kid: stored.kid,
      typ: "JWT",
    });
    const encodedPayload = encodeJson({
      iss: options.issuer,
      aud: LOCAL_JWT_AUDIENCE,
      sub: LOCAL_JWT_SUBJECT,
      role,
      email: "local@qali.app",
      name: "Qali User",
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      jti: randomBytes(16).toString("base64url"),
    });
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  };

  const createTokenProvider = (role: LocalJwtRole): LocalJwtTokenProvider => {
    let cached: { token: string; expiresAt: number } | null = null;
    return Object.freeze({
      async getToken({ forceRefreshToken }) {
        const nowSeconds = Math.floor(now() / 1_000);
        if (
          !forceRefreshToken &&
          cached !== null &&
          cached.expiresAt - nowSeconds > REFRESH_WINDOW_SECONDS
        ) {
          return cached.token;
        }
        const token = await mint(role);
        cached = {
          token,
          expiresAt: nowSeconds + TOKEN_LIFETIME_SECONDS,
        };
        return token;
      },
    });
  };

  return Object.freeze({
    issuer: options.issuer,
    jwks,
    mintRendererToken: async () => await mint("renderer"),
    mintDesktopBrokerToken: async () => await mint("desktop_broker"),
    createRendererTokenProvider: () => createTokenProvider("renderer"),
    createDesktopBrokerTokenProvider: () =>
      createTokenProvider("desktop_broker"),
  });
}
