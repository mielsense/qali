import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type ReleaseManifest = {
  formatVersion: 1;
  target: "aarch64-apple-darwin";
  convex: {
    cli: { path: string; sha256: string; bytes: number };
    backend: {
      asset: "convex-local-backend-aarch64-apple-darwin.zip";
      sourceUrl: string;
      archiveSha256: string;
      path: string;
      sha256: string;
      bytes: number;
    };
  };
};

const repositoryRoot = resolve(import.meta.dir, "../..");
const resourcesRoot = join(repositoryRoot, "apps/desktop/resources");
const manifest = JSON.parse(
  await readFile(join(resourcesRoot, "release-manifest.json"), "utf8"),
) as ReleaseManifest;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPinnedManifest(): void {
  if (
    manifest.formatVersion !== 1 ||
    manifest.target !== "aarch64-apple-darwin" ||
    manifest.convex.backend.asset !== "convex-local-backend-aarch64-apple-darwin.zip" ||
    !manifest.convex.backend.sourceUrl.startsWith(
      "https://github.com/get-convex/convex-backend/releases/download/precompiled-2026-07-25-f4a0132/",
    )
  ) throw new Error("Release manifest does not declare the approved arm64 Convex artifact");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Convex artifacts may be fetched only on the approved darwin-arm64 target");
  }
}

async function copyPinnedCliBundle(): Promise<void> {
  const source = join(
    repositoryRoot,
    "packages/backend/node_modules/convex/dist/cli.bundle.cjs",
  );
  const bytes = await readFile(source);
  if (bytes.byteLength !== manifest.convex.cli.bytes || sha256(bytes) !== manifest.convex.cli.sha256) {
    throw new Error("Installed Convex CLI does not match the pinned release manifest");
  }
  const target = join(resourcesRoot, manifest.convex.cli.path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  await chmod(target, 0o600);
}

async function fetchBackend(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "qali-convex-artifact-"));
  try {
    const archivePath = join(temporaryRoot, manifest.convex.backend.asset);
    const response = await fetch(manifest.convex.backend.sourceUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Convex artifact download failed (${response.status})`);
    const archive = new Uint8Array(await response.arrayBuffer());
    if (sha256(archive) !== manifest.convex.backend.archiveSha256) {
      throw new Error("Downloaded Convex archive hash does not match the release manifest");
    }
    await Bun.write(archivePath, archive);
    const extraction = Bun.spawnSync(
      ["/usr/bin/unzip", "-qq", archivePath, "convex-local-backend", "-d", temporaryRoot],
      { env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" }, stderr: "pipe", stdout: "pipe" },
    );
    if (extraction.exitCode !== 0) throw new Error("Pinned Convex archive could not be extracted");
    const extracted = join(temporaryRoot, "convex-local-backend");
    const metadata = await lstat(extracted);
    const bytes = await readFile(extracted);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== manifest.convex.backend.bytes ||
      sha256(bytes) !== manifest.convex.backend.sha256
    ) throw new Error("Extracted Convex backend does not match the release manifest");
    const target = join(resourcesRoot, manifest.convex.backend.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(extracted, target);
    await chmod(target, 0o755);
    if ((await stat(target)).size !== manifest.convex.backend.bytes) {
      throw new Error("Convex backend copy was incomplete");
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

assertPinnedManifest();
await Promise.all([fetchBackend(), copyPinnedCliBundle()]);
console.log("Fetched and verified pinned darwin-arm64 Convex artifacts.");
