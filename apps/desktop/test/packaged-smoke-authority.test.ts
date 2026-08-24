import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const authorityModule = await import(
  "../src/main/packaged-smoke-authority"
).catch((error: unknown) => ({ error }));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qali-packaged-smoke-"));
  roots.push(root);
  await chmod(root, 0o700);
  const nonce = "a".repeat(64);
  const applicationAsarSha256 = "b".repeat(64);
  await writeFile(
    join(root, ".qali-packaged-smoke-authority.json"),
    `${JSON.stringify({ applicationAsarSha256, formatVersion: 1, nonce, phase: "seed" })}\n`,
    { mode: 0o600 },
  );
  return {
    applicationAsarSha256,
    formatVersion: 1 as const,
    nonce,
    phase: "seed" as const,
    root,
  };
}

describe("opaque packaged smoke authority", () => {
  test("accepts an exact one-shot authority rooted below the real OS temp directory", async () => {
    expect("error" in authorityModule).toBe(false);
    if ("error" in authorityModule) return;
    const value = await fixture();
    const result = await authorityModule.validatePackagedSmokeAuthority(value, {
      applicationAsarSha256: value.applicationAsarSha256,
      repositoryRoot: resolve(import.meta.dir, "../../.."),
    });
    expect(result.channel).toBe("test");
    expect(result.phase).toBe("seed");
    expect(result.appData).toBe(await realpath(value.root));
    expect(result.readyMarker).toContain("Qali Test/runtime/packaged-smoke-ready.json");
  });

  test("rejects nonce/hash mismatch, loose roots, and repository-contained paths", async () => {
    expect("error" in authorityModule).toBe(false);
    if ("error" in authorityModule) return;
    const value = await fixture();
    await expect(
      authorityModule.validatePackagedSmokeAuthority(
        { ...value, nonce: "c".repeat(64) },
        {
          applicationAsarSha256: value.applicationAsarSha256,
          repositoryRoot: resolve(import.meta.dir, "../../.."),
        },
      ),
    ).rejects.toThrow("PACKAGED_SMOKE_AUTHORITY_REJECTED");

    await expect(
      authorityModule.validatePackagedSmokeAuthority(
        { ...value, phase: "verify" },
        {
          applicationAsarSha256: value.applicationAsarSha256,
          repositoryRoot: resolve(import.meta.dir, "../../.."),
        },
      ),
    ).rejects.toThrow("PACKAGED_SMOKE_AUTHORITY_REJECTED");
    await chmod(value.root, 0o755);
    await expect(
      authorityModule.validatePackagedSmokeAuthority(value, {
        applicationAsarSha256: value.applicationAsarSha256,
        repositoryRoot: resolve(import.meta.dir, "../../.."),
      }),
    ).rejects.toThrow("PACKAGED_SMOKE_AUTHORITY_REJECTED");
    await expect(
      authorityModule.validatePackagedSmokeAuthority(
        { ...value, root: resolve(import.meta.dir, "../resources") },
        {
          applicationAsarSha256: value.applicationAsarSha256,
          repositoryRoot: resolve(import.meta.dir, "../../.."),
        },
      ),
    ).rejects.toThrow("PACKAGED_SMOKE_AUTHORITY_REJECTED");
  });

  test("reads authority only with a matching physical packaged-smoke build identity", async () => {
    expect("error" in authorityModule).toBe(false);
    if ("error" in authorityModule) return;
    const value = await fixture();
    let reads = 0;
    await expect(
      authorityModule.loadPackagedSmokeAuthority({
        applicationAsarSha256: value.applicationAsarSha256,
        isPackaged: true,
        readAuthority: () => {
          reads += 1;
          return JSON.stringify(value);
        },
        readBuildIdentity: () => {
          throw new Error("missing");
        },
        repositoryRoot: resolve(import.meta.dir, "../../.."),
      }),
    ).rejects.toThrow("PACKAGED_SMOKE_AUTHORITY_REJECTED");
    expect(reads).toBe(0);

    const accepted = await authorityModule.loadPackagedSmokeAuthority({
      applicationAsarSha256: value.applicationAsarSha256,
      isPackaged: true,
      readAuthority: () => {
        reads += 1;
        return JSON.stringify(value);
      },
      readBuildIdentity: () =>
        JSON.stringify({
          applicationAsarSha256: value.applicationAsarSha256,
          formatVersion: 1,
          kind: "qali-packaged-smoke-build",
          nonce: value.nonce,
        }),
      repositoryRoot: resolve(import.meta.dir, "../../.."),
    });
    expect(accepted?.phase).toBe("seed");
    expect(reads).toBe(1);

    await expect(
      authorityModule.loadPackagedSmokeAuthority({
        applicationAsarSha256: value.applicationAsarSha256,
        isPackaged: true,
        readAuthority: () => JSON.stringify(value),
        readBuildIdentity: () =>
          JSON.stringify({
            applicationAsarSha256: value.applicationAsarSha256,
            formatVersion: 1,
            kind: "qali-packaged-smoke-build",
            nonce: "c".repeat(64),
          }),
        repositoryRoot: resolve(import.meta.dir, "../../.."),
      }),
    ).rejects.toThrow("PACKAGED_SMOKE_AUTHORITY_REJECTED");
  });
});
