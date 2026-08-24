import { execFile } from "node:child_process";
import { chmod, copyFile, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { inspectAppBundle, validateBundleSnapshot } from "./lib/app-bundle-verifier";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dir, "../..");
const releaseApp = resolve(repositoryRoot, "dist/Qali.app");
const probeApp = resolve(repositoryRoot, "dist/Qali-verifier-injection-probe.app");

async function resetProbe(): Promise<void> {
  await rm(probeApp, { force: true, recursive: true });
  await execFileAsync("/usr/bin/ditto", [releaseApp, probeApp]);
}

async function expectRules(
  name: string,
  mutate: () => Promise<void>,
  expected: readonly string[],
): Promise<void> {
  await resetProbe();
  await mutate();
  const rules = new Set(
    validateBundleSnapshot(await inspectAppBundle(probeApp)).issues.map(
      (issue) => issue.rule,
    ),
  );
  for (const rule of expected) {
    if (!rules.has(rule)) throw new Error(`${name} did not trigger ${rule}`);
  }
  console.log(`Injection probe ${name}: ${expected.join(", ")}`);
}

try {
  await expectRules(
    "executable-script",
    async () => {
      const path = resolve(probeApp, "Contents/Resources/injected.sh");
      await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await chmod(path, 0o755);
    },
    ["RESOURCE_INVENTORY_UNEXPECTED", "NON_MACHO_EXECUTABLE"],
  );
  await expectRules(
    "resource-symlink",
    () => symlink("release-manifest.json", resolve(probeApp, "Contents/Resources/injected-link")),
    ["RESOURCE_INVENTORY_UNEXPECTED", "RESOURCE_SYMLINK"],
  );
  await expectRules(
    "resource-byte-change",
    async () => {
      const path = resolve(probeApp, "Contents/Resources/codex-calendar.sb");
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from("\n# injected\n")]));
    },
    ["RESOURCE_INVENTORY_METADATA"],
  );
  await expectRules(
    "unexpected-mach-o",
    () => copyFile(
      resolve(probeApp, "Contents/Resources/bin/keychain-helper"),
      resolve(probeApp, "Contents/Resources/bin/injected-tool"),
    ),
    ["RESOURCE_INVENTORY_UNEXPECTED", "EXECUTABLE_INVENTORY_UNEXPECTED"],
  );
} finally {
  await rm(probeApp, { force: true, recursive: true });
}
