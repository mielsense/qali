import { createPackage, extractAll, uncache } from "@electron/asar";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { verifyRawPackagedOutputPolicy } from "./lib/packaged-output-policy";

const repositoryRoot = resolve(import.meta.dir, "../..");
const resources = resolve(repositoryRoot, "dist/Qali.app/Contents/Resources");
const probe = resolve(repositoryRoot, "dist/.output-policy-probe");
const probeResources = resolve(probe, "Contents/Resources");

await rm(probe, { force: true, recursive: true });
await mkdir(probeResources, { recursive: true, mode: 0o700 });
try {
  // The final self-manifest is deliberately not copied: it never exists at the
  // raw builder boundary governed by this policy.
  const bun = Bun.spawn(["/usr/bin/ditto", resources, probeResources], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (await bun.exited !== 0) throw new Error(await new Response(bun.stderr).text());
  await rm(resolve(probeResources, "packaged-resource-manifest.json"));
  const extracted = resolve(probe, "asar-source");
  extractAll(resolve(probeResources, "app.asar"), extracted);
  await writeFile(resolve(extracted, "untracked-generated-output.ts"), "export {};\n", { mode: 0o644 });
  const replacement = resolve(probe, "app.injected.asar");
  await createPackage(extracted, replacement);
  await copyFile(replacement, resolve(probeResources, "app.asar"));
  uncache(resolve(probeResources, "app.asar"));
  let rejected = false;
  try {
    await verifyRawPackagedOutputPolicy(probe, repositoryRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rejected = message.includes("ASAR_INVENTORY_UNEXPECTED:/untracked-generated-output.ts");
  }
  if (!rejected) throw new Error("OUTPUT_POLICY_INJECTION_NOT_REJECTED");
  console.log("Pre-seal injection probe: ASAR_INVENTORY_UNEXPECTED:/untracked-generated-output.ts");
} finally {
  await rm(probe, { force: true, recursive: true });
}
