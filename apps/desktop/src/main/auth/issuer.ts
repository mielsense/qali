import { createServer, type Server } from "node:http";

import type { AppChannel } from "../identity";
import type { KeychainStore } from "../keychain/keychain";
import { createLocalJwtAuthority, type LocalJwtAuthority } from "./jwt";

type SigningKeyStore = Pick<KeychainStore, "get" | "set">;

export const LOCAL_AUTH_PORTS = Object.freeze({
  stable: 3212,
  development: 3312,
  test: 3412,
} as const satisfies Record<AppChannel, number>);

export function localAuthIssuerForChannel(channel: AppChannel): string {
  return `http://127.0.0.1:${LOCAL_AUTH_PORTS[channel]}`;
}

export type LocalAuthIssuerOptions = Readonly<{
  hostname: "127.0.0.1";
  port: number;
  keychain: SigningKeyStore;
  now?: () => number;
}>;

export type LocalAuthIssuer = Readonly<{
  issuer: string;
  authority: LocalJwtAuthority;
  close(): Promise<void>;
}>;

function listen(
  server: Server,
  hostname: string,
  port: number,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = () =>
      rejectPromise(new Error("Local auth issuer could not bind"));
    server.once("error", onError);
    server.listen(port, hostname, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(
          new Error("Local auth issuer did not bind to TCP loopback"),
        );
        return;
      }
      resolvePromise(address.port);
    });
  });
}

export async function startLocalAuthIssuer(
  options: LocalAuthIssuerOptions,
): Promise<LocalAuthIssuer> {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error("Local auth issuer port is invalid");
  }

  let authority: LocalJwtAuthority | null = null;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    if (authority === null) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "issuer_not_ready" }));
      return;
    }
    if (request.url === "/.well-known/openid-configuration") {
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          issuer: authority.issuer,
          jwks_uri: `${authority.issuer}/jwks.json`,
          id_token_signing_alg_values_supported: ["RS256"],
          subject_types_supported: ["public"],
        }),
      );
      return;
    }
    if (request.url === "/jwks.json") {
      response.statusCode = 200;
      response.end(JSON.stringify(authority.jwks));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  server.keepAliveTimeout = 1_000;
  server.requestTimeout = 2_000;
  server.headersTimeout = 2_000;

  let port: number;
  try {
    port = await listen(server, options.hostname, options.port);
    authority = await createLocalJwtAuthority({
      issuer: `http://${options.hostname}:${port}`,
      keychain: options.keychain,
      now: options.now,
    });
  } catch (error) {
    server.close();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    issuer: authority.issuer,
    authority,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
      });
    },
  });
}
