import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { verifyReleaseInputAllowlist } from "./lib/release-input-allowlist";

const repositoryRoot = resolve(import.meta.dir, "../..");
const probes = [
  "packages/backend/convex/qali-benign-release-proof.ts",
  "apps/web/src/qali-benign-release-proof.tsx",
  "apps/desktop/resources/qali-benign-release-proof.txt",
  "apps/desktop/node_modules/zod/v4/qali-benign-release-proof.js",
] as const;

await verifyReleaseInputAllowlist(repositoryRoot);
for (const logicalPath of probes) {
  const path = resolve(repositoryRoot, logicalPath);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, "export const benignReleaseProof = true;\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    let rejected = false;
    try {
      await verifyReleaseInputAllowlist(repositoryRoot);
    } catch (error) {
      rejected = error instanceof Error &&
        error.message.includes(`RELEASE_INPUT_UNEXPECTED:${logicalPath}`);
    }
    if (!rejected) throw new Error(`RELEASE_INPUT_PROBE_ACCEPTED:${logicalPath}`);
  } finally {
    await rm(path, { force: true });
  }
  await verifyReleaseInputAllowlist(repositoryRoot);
}

console.log(`Release input probes passed: ${probes.join(", ")}`);
