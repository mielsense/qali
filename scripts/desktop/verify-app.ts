import { createHash } from "node:crypto";
import {
  lstat,
  opendir,
  readFile,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { BRIDGE_VERSION } from "@qali/desktop-contracts";

import {
  canonicalInventoryRoot,
  inspectAppBundle,
  type PackagedResourceManifest,
  validateBundleSnapshot,
} from "./lib/app-bundle-verifier";
import { collectLocalDevelopmentSourceState } from "./lib/release-input-allowlist";

const repositoryRoot = resolve(import.meta.dir, "../..");
const appPath = resolve(repositoryRoot, "dist/Qali.app");

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function treeDigest(
  root: string,
): Promise<{ bytes: number; sha256: string }> {
  const hasher = createHash("sha256");
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const metadata = await lstat(absolute);
      hasher.update(`${path}\0${metadata.mode & 0o7777}\0`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink())
        hasher.update(`link\0${await readlink(absolute)}\0`);
      else if (entry.isFile()) {
        const content = await readFile(absolute);
        bytes += content.byteLength;
        hasher.update(`file\0${content.byteLength}\0`).update(content);
      }
    }
  }
  await visit(root);
  return { bytes, sha256: hasher.digest("hex") };
}

export async function verifyFinalApp(
  options: Readonly<{
    localDevelopment?: boolean;
    notarizationId?: string;
    signature?: string;
  }> = {},
): Promise<void> {
  if ((await realpath(appPath)) !== appPath)
    throw new Error("FINAL_APP_PATH_NOT_CANONICAL");
  const snapshot = await inspectAppBundle(
    appPath,
    options.localDevelopment
      ? await collectLocalDevelopmentSourceState(repositoryRoot)
      : undefined,
  );
  const validation = validateBundleSnapshot(snapshot);
  if (validation.issues.length > 0) {
    for (const issue of validation.issues) {
      console.error(
        `${issue.rule}${issue.path ? ` ${issue.path}` : ""}: ${issue.detail}`,
      );
    }
    throw new Error(
      `Qali.app verification failed with ${validation.issues.length} issue(s)`,
    );
  }

  const resources = resolve(appPath, "Contents/Resources");
  const releaseManifest = JSON.parse(
    await readFile(resolve(resources, "release-manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  const packagedManifestBytes = await readFile(
    resolve(resources, "packaged-resource-manifest.json"),
  );
  const packagedManifest = JSON.parse(
    packagedManifestBytes.toString("utf8"),
  ) as PackagedResourceManifest;
  const codexManifest = JSON.parse(
    await readFile(resolve(resources, "codex-provider-manifest.json"), "utf8"),
  ) as {
    capability: { blockerCode: string; status: string };
    executable: { version: string };
  };
  const executable = await readFile(resolve(appPath, "Contents/MacOS/Qali"));
  const schemas = {
    finalizer: sha256(
      await readFile(resolve(resources, "codex-finalizer-output.schema.json")),
    ),
    planner: sha256(
      await readFile(resolve(resources, "codex-planner-output.schema.json")),
    ),
  };
  const tree = await treeDigest(appPath);
  const evidence = {
    app: {
      architecture: "arm64",
      bytes: tree.bytes,
      bundleId: snapshot.app.bundleId,
      executableSha256: sha256(executable),
      path: "dist/Qali.app",
      notarizationId: options.notarizationId ?? null,
      signature: options.signature ?? "ad-hoc (not notarized)",
      treeSha256: tree.sha256,
      version: snapshot.app.version,
    },
    boundaries: {
      bridgeVersion: BRIDGE_VERSION,
      codex: {
        blockerCode: codexManifest.capability.blockerCode,
        bundled: false,
        status: codexManifest.capability.status,
        version: codexManifest.executable.version,
      },
      convex: releaseManifest,
      electron: "43.2.0",
      schemas,
    },
    executables: snapshot.executableFiles.map((entry) => ({
      architectures: entry.architectures,
      bytes: entry.bytes,
      mode: entry.mode & 0o777,
      path: entry.path,
      sha256: entry.sha256,
      signatureIdentity: entry.signatureIdentity,
      signatureValid: entry.signatureValid,
    })),
    formatVersion: 2,
    packagedResources: {
      asarEntries: packagedManifest.asarEntries.length,
      asarInventorySha256: canonicalInventoryRoot(packagedManifest.asarEntries),
      buildInputs: packagedManifest.inputs,
      manifestBytes: packagedManifestBytes.byteLength,
      manifestSha256: sha256(packagedManifestBytes),
      resourceEntries: packagedManifest.resourceEntries.length,
      resourceInventorySha256: canonicalInventoryRoot(
        packagedManifest.resourceEntries,
      ),
      selfExclusion:
        "Contents/Resources/packaged-resource-manifest.json; sealed by final main-app signature",
    },
    source: {
      dependencyLockSha256: packagedManifest.inputs.dependencyLock.sha256,
      revision: packagedManifest.inputs.source.revision,
      scopedWorkingTreePatchSha256: packagedManifest.inputs.source.patchSha256,
    },
    testEvidence: [
      "package-release.test.ts",
      "app-bundle-verifier.test.ts",
      "packaged-smoke-authority.test.ts",
      "build-app.test.ts",
      "owned-spawn-observer.test.ts",
      "owned-spawn-evidence.test.ts",
      "release-input-allowlist.test.ts",
    ],
    verification: {
      asarEntries: snapshot.asarFiles.length,
      executableCount: snapshot.executableFiles.length,
      forbiddenMatchCount: 0,
      resourceManifestHashesAgree: true,
      signatureValid: true,
    },
  };
  const evidencePath = resolve(
    repositoryRoot,
    "dist/qali-release-evidence.json",
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  console.log(
    `Verified ${appPath}: ${snapshot.executableFiles.length} arm64 executables, ${snapshot.asarFiles.length} ASAR entries, tree ${tree.sha256}`,
  );
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  const argumentsList = process.argv.slice(2);
  if (
    argumentsList.length > 1 ||
    (argumentsList.length === 1 && argumentsList[0] !== "--local-development")
  ) {
    throw new Error("VERIFY_APP_ARGUMENT_INVALID");
  }
  await verifyFinalApp({
    localDevelopment: argumentsList[0] === "--local-development",
  });
}
