import { afterEach, describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";

import {
  LOCAL_JWT_AUDIENCE,
  LOCAL_JWT_SUBJECT,
  createLocalJwtAuthority,
} from "../src/main/auth/jwt";
import { startLocalAuthIssuer } from "../src/main/auth/issuer";

class MemoryKeychain {
  readonly values = new Map<string, string>();
  setCalls = 0;

  async get(account: "local-jwt-signing-key"): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async set(account: "local-jwt-signing-key", value: string): Promise<void> {
    this.setCalls += 1;
    this.values.set(account, value);
  }
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

function decodeToken(token: string) {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Malformed JWT fixture");
  }
  return {
    encodedHeader,
    encodedPayload,
    encodedSignature,
    header: decodePart<Record<string, unknown>>(encodedHeader),
    payload: decodePart<Record<string, unknown>>(encodedPayload),
  };
}

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("local JWT authority", () => {
  test("mints short-lived, role-separated RS256 tokens from Keychain material", async () => {
    let nowMs = 1_800_000_000_000;
    const keychain = new MemoryKeychain();
    const authority = await createLocalJwtAuthority({
      issuer: "http://127.0.0.1:3412",
      keychain,
      now: () => nowMs,
    });

    const renderer = decodeToken(await authority.mintRendererToken());
    const broker = decodeToken(await authority.mintDesktopBrokerToken());

    expect(renderer.header).toEqual({
      alg: "RS256",
      kid: authority.jwks.keys[0]?.kid,
      typ: "JWT",
    });
    expect(renderer.payload).toMatchObject({
      iss: "http://127.0.0.1:3412",
      aud: LOCAL_JWT_AUDIENCE,
      sub: LOCAL_JWT_SUBJECT,
      role: "renderer",
      iat: 1_800_000_000,
    });
    expect(broker.payload.role).toBe("desktop_broker");
    expect(
      Number(renderer.payload.exp) - Number(renderer.payload.iat),
    ).toBeLessThanOrEqual(300);

    const publicKey = createPublicKey({
      key: authority.jwks.keys[0]!,
      format: "jwk",
    });
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${renderer.encodedHeader}.${renderer.encodedPayload}`),
        publicKey,
        Buffer.from(renderer.encodedSignature, "base64url"),
      ),
    ).toBe(true);

    const serializedJwks = JSON.stringify(authority.jwks);
    expect(serializedJwks).not.toContain("PRIVATE KEY");
    expect(serializedJwks).not.toContain('"d"');
    expect(keychain.values.get("local-jwt-signing-key")).toContain(
      "PRIVATE KEY",
    );

    nowMs += 1_000;
    expect(decodeToken(await authority.mintRendererToken()).payload.role).toBe(
      "renderer",
    );
  });

  test("refreshes a renderer token before expiry without exposing the signing key", async () => {
    let nowMs = 1_800_000_000_000;
    const authority = await createLocalJwtAuthority({
      issuer: "http://127.0.0.1:3412",
      keychain: new MemoryKeychain(),
      now: () => nowMs,
    });
    const provider = authority.createRendererTokenProvider();

    const first = await provider.getToken({ forceRefreshToken: false });
    nowMs += 30_000;
    expect(await provider.getToken({ forceRefreshToken: false })).toBe(first);
    nowMs += 100_000;
    const refreshed = await provider.getToken({ forceRefreshToken: false });
    expect(refreshed).not.toBe(first);
    expect(decodeToken(refreshed).payload.role).toBe("renderer");
  });

  test("reuses the Keychain signing key across authority restarts", async () => {
    const keychain = new MemoryKeychain();
    const first = await createLocalJwtAuthority({
      issuer: "http://127.0.0.1:3412",
      keychain,
    });
    const second = await createLocalJwtAuthority({
      issuer: "http://127.0.0.1:3412",
      keychain,
    });

    expect(second.jwks).toEqual(first.jwks);
    expect(keychain.setCalls).toBe(1);
  });
});

describe("loopback JWT issuer", () => {
  test("serves exact discovery and public JWKS routes only", async () => {
    const server = await startLocalAuthIssuer({
      hostname: "127.0.0.1",
      port: 0,
      keychain: new MemoryKeychain(),
    });
    servers.push(server);

    const discovery = await fetch(
      `${server.issuer}/.well-known/openid-configuration`,
    );
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({
      issuer: server.issuer,
      jwks_uri: `${server.issuer}/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
      subject_types_supported: ["public"],
    });

    const jwks = await (await fetch(`${server.issuer}/jwks.json`)).text();
    expect(JSON.parse(jwks)).toEqual(server.authority.jwks);
    expect(jwks).not.toContain("PRIVATE KEY");
    expect(jwks).not.toContain('"d"');
    expect((await fetch(`${server.issuer}/jwks.json?extra=1`)).status).toBe(
      404,
    );
    expect((await fetch(`${server.issuer}/`, { method: "POST" })).status).toBe(
      405,
    );
  });
});
