import type { AuthConfig } from "convex/server";

import {
  LOCAL_AUTH_AUDIENCE,
  LOCAL_AUTH_ISSUERS,
} from "./domains/desktop/identity";

export function authConfigForChannel(channel: unknown): AuthConfig {
  if (channel === undefined) {
    throw new Error("QALI_LOCAL_AUTH_CHANNEL_REQUIRED");
  }
  if (
    channel !== "stable" &&
    channel !== "development" &&
    channel !== "test"
  ) {
    throw new Error("QALI_LOCAL_AUTH_CHANNEL_INVALID");
  }
  const issuer = LOCAL_AUTH_ISSUERS[channel];
  return {
    providers: [
      {
        type: "customJwt",
        applicationID: LOCAL_AUTH_AUDIENCE,
        issuer,
        jwks: `${issuer}/jwks.json`,
        algorithm: "RS256",
      },
    ],
  };
}

export default authConfigForChannel(process.env.QALI_LOCAL_AUTH_CHANNEL);
