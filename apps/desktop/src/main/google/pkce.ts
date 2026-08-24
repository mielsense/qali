import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export type RandomBytes = (size: number) => Uint8Array;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export type PkceMaterial = Readonly<{
  challenge: string;
  state: string;
  verifier: string;
}>;

export function createPkceMaterial(
  randomBytes: RandomBytes = nodeRandomBytes,
): PkceMaterial {
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(32));
  if (state.length < 43 || verifier.length < 43) {
    throw new Error("GOOGLE_OAUTH_ENTROPY_UNAVAILABLE");
  }
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return Object.freeze({ challenge, state, verifier });
}
