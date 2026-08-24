import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertSameReleaseInputPaths,
  collectReleaseSourceState,
  collectReleaseInputEntries,
  isDeclaredTrackedReleasePath,
  type ReleaseInputAllowlist,
} from "./lib/release-input-allowlist";

const repositoryRoot = resolve(import.meta.dir, "../..");
const execFileAsync = promisify(execFile);
const target = resolve(
  repositoryRoot,
  "apps/desktop/release-input-allowlist.json",
);
const argumentsList = process.argv.slice(2);
const acceptLocalPathSetChanges = argumentsList.includes(
  "--accept-local-path-set-changes",
);
if (
  argumentsList.some(
    (argument) => argument !== "--accept-local-path-set-changes",
  )
) {
  throw new Error("RELEASE_INPUT_GENERATOR_ARGUMENT_INVALID");
}
if (acceptLocalPathSetChanges && process.env.CI === "true") {
  throw new Error("RELEASE_INPUT_LOCAL_PATH_SET_CHANGES_FORBIDDEN_IN_CI");
}
const existing = JSON.parse(
  await readFile(target, "utf8"),
) as ReleaseInputAllowlist;
const entries = await collectReleaseInputEntries(repositoryRoot);
try {
  assertSameReleaseInputPaths(existing.entries, entries);
} catch {
  const existingPaths = new Set(existing.entries.map(({ path }) => path));
  const actualPaths = new Set(entries.map(({ path }) => path));
  const missing = [...existingPaths].filter((path) => !actualPaths.has(path));
  const added = [...actualPaths].filter((path) => !existingPaths.has(path));
  if (!acceptLocalPathSetChanges) {
    await collectReleaseSourceState(repositoryRoot);
    if (missing.length > 0 || added.length === 0) {
      throw new Error(
        `RELEASE_INPUT_PATH_SET_CHANGED:${missing[0] ?? "unknown"}`,
      );
    }
    for (const path of added) {
      if (!isDeclaredTrackedReleasePath(path)) {
        throw new Error(`RELEASE_INPUT_PATH_SET_CHANGED:${path}`);
      }
      await execFileAsync(
        "/usr/bin/git",
        ["ls-files", "--error-unmatch", "--", path],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
        },
      );
    }
  }
}
const allowlist = {
  entries,
  formatVersion: 1,
} as const;
await writeFile(target, `${JSON.stringify(allowlist, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
console.log(
  `Wrote ${allowlist.entries.length} exact release input proofs${
    acceptLocalPathSetChanges ? " after an explicit local path-set review" : ""
  }.`,
);
