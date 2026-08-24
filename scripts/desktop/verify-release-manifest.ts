import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

type Artifact = { path: string; sha256: string; bytes?: number };
type Manifest = {
  formatVersion: number;
  target: string;
  convex: {
    clientVersion: string;
    cli: Artifact & { version: string };
    backend: Artifact & {
      archiveSha256: string;
      asset: string;
      commit: string;
      release: string;
      sourceUrl: string;
    };
    keygen: Artifact & {
      sourceArchiveSha256: string;
      sourceCommit: string;
      sourcePath: string;
      sourceUrl: string;
      compiler: string;
      protocol: string;
      maxRequestBytes: number;
      wrapperPath: string;
      wrapperSha256: string;
      testVectors: Array<{
        instanceName: string;
        instanceSecret: string;
        outputPattern: string;
      }>;
    };
  };
};

const repositoryRoot = resolve(import.meta.dir, "../..");
const resourcesRoot = join(repositoryRoot, "apps/desktop/resources");
const manifest = JSON.parse(await readFile(join(resourcesRoot, "release-manifest.json"), "utf8")) as Manifest;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertManifest(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Release manifest verification requires darwin-arm64");
  }
  if (
    manifest.formatVersion !== 1 ||
    manifest.target !== "aarch64-apple-darwin" ||
    manifest.convex.clientVersion !== "1.42.1" ||
    manifest.convex.cli.version !== "1.42.1" ||
    manifest.convex.backend.release !== "precompiled-2026-07-25-f4a0132" ||
    manifest.convex.backend.asset !== "convex-local-backend-aarch64-apple-darwin.zip" ||
    manifest.convex.backend.commit !== "f4a0132c073eb7c8545dc90ff48abb47f8d7ba73" ||
    manifest.convex.keygen.sourceCommit !== "f4a0132c073eb7c8545dc90ff48abb47f8d7ba73" ||
    manifest.convex.keygen.sourcePath !== "crates/keybroker/src/bin/generate_key.rs" ||
    manifest.convex.keygen.compiler !== "rustc 1.98.0-nightly (13f1859f2 2026-06-27)" ||
    manifest.convex.keygen.protocol !== "stdin-json-v1" ||
    manifest.convex.keygen.maxRequestBytes !== 4096 ||
    manifest.convex.keygen.wrapperPath !== "apps/desktop/native/convex-keygen/generate_key.rs" ||
    !/^[a-f0-9]{64}$/.test(manifest.convex.keygen.wrapperSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.convex.backend.archiveSha256) ||
    !/^[a-f0-9]{64}$/.test(manifest.convex.keygen.sourceArchiveSha256) ||
    !manifest.convex.backend.sourceUrl.startsWith("https://github.com/get-convex/convex-backend/") ||
    !manifest.convex.keygen.sourceUrl.startsWith("https://github.com/get-convex/convex-backend/")
  ) throw new Error("Release manifest versions or target do not match the approved release unit");
}

async function verifyArtifact(artifact: Artifact, executable: boolean): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`Artifact ${artifact.path} has no committed SHA-256`);
  }
  const path = join(resourcesRoot, artifact.path);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Artifact ${artifact.path} is not a regular file`);
  }
  if (artifact.bytes !== undefined && metadata.size !== artifact.bytes) {
    throw new Error(`Artifact ${artifact.path} size mismatch`);
  }
  if (sha256(await readFile(path)) !== artifact.sha256) {
    throw new Error(`Artifact ${artifact.path} hash mismatch`);
  }
  if (executable) {
    const header = (await readFile(path)).subarray(0, 8);
    if (header.toString("hex", 0, 4) !== "cffaedfe" || header.readUInt32LE(4) !== 0x0100000c) {
      throw new Error(`Artifact ${artifact.path} is not an arm64 Mach-O executable`);
    }
    if (((await stat(path)).mode & 0o111) === 0) {
      throw new Error(`Artifact ${artifact.path} is not executable`);
    }
  }
  return path;
}

assertManifest();
await verifyArtifact(manifest.convex.cli, false);
await verifyArtifact(manifest.convex.backend, true);
const keygenPath = await verifyArtifact(manifest.convex.keygen, true);
const wrapperPath = join(repositoryRoot, manifest.convex.keygen.wrapperPath);
if (sha256(await readFile(wrapperPath)) !== manifest.convex.keygen.wrapperSha256) {
  throw new Error("Convex key-generator wrapper hash mismatch");
}
for (const vector of manifest.convex.keygen.testVectors) {
  const child = Bun.spawnSync(
    [keygenPath],
    {
      env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      stderr: "pipe",
      stdin: Buffer.from(JSON.stringify({
        instanceName: vector.instanceName,
        instanceSecret: vector.instanceSecret,
      }), "utf8"),
      stdout: "pipe",
    },
  );
  const output = child.stdout.toString().trim();
  if (child.exitCode !== 0 || !(new RegExp(vector.outputPattern).test(output))) {
    throw new Error("Convex key-generator compatibility vector failed");
  }
}
console.log("Verified pinned Convex release manifest for darwin-arm64.");
