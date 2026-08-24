import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  electronBuilderArguments,
  encodePackagedGoogleClientResource,
  releasePath,
  resolveGoogleClientSecret,
} from "./build-app";
import {
  collectRawPackagedOutput,
  encodePackagedOutputPolicy,
} from "./lib/packaged-output-policy";
import {
  collectLocalDevelopmentSourceState,
  collectReleaseSourceState,
  verifyReleaseInputAllowlist,
} from "./lib/release-input-allowlist";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(import.meta.dir, "../..");
const desktopRoot = join(repositoryRoot, "apps/desktop");
const output = join(repositoryRoot, "dist");
const target = join(desktopRoot, "packaged-output-policy.json");

export type OutputPolicyMode = Readonly<{ localDevelopment: boolean }>;

export function parseOutputPolicyMode(
  argumentsList: readonly string[],
  continuousIntegration: boolean,
): OutputPolicyMode {
  if (
    argumentsList.length === 0 ||
    (argumentsList.length === 1 && argumentsList[0] === "--local-development")
  ) {
    const localDevelopment = argumentsList[0] === "--local-development";
    if (localDevelopment && continuousIntegration) {
      throw new Error("LOCAL_OUTPUT_POLICY_FORBIDDEN_IN_CI");
    }
    return { localDevelopment };
  }
  throw new Error("OUTPUT_POLICY_ARGUMENT_INVALID");
}

const environment: NodeJS.ProcessEnv = {
  CI: "1",
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  LANG: "C.UTF-8",
  LC_ALL: "C",
  NODE_ENV: "production",
  PATH: releasePath(process.execPath),
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
};

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(
            new Error(`Output-policy command failed: ${code ?? signal}`),
          ),
    );
  });
}

export async function generatePackagedOutputPolicy(
  mode: OutputPolicyMode,
): Promise<void> {
  await verifyReleaseInputAllowlist(repositoryRoot);
  if (mode.localDevelopment) {
    await collectLocalDevelopmentSourceState(repositoryRoot);
  } else {
    await collectReleaseSourceState(repositoryRoot);
  }
  await rm(output, { force: true, recursive: true });
  await mkdir(output, { mode: 0o700 });
  await run(
    process.execPath,
    ["run", "desktop:verify-release-manifest"],
    repositoryRoot,
  );
  await run(process.execPath, ["run", "build"], desktopRoot);
  const releaseInputsRoot = join(output, ".release-inputs");
  const publicClientSource = await readFile(
    join(desktopRoot, "resources/google-oauth-client.json"),
    "utf8",
  );
  await mkdir(releaseInputsRoot, { mode: 0o700 });
  await writeFile(
    join(releaseInputsRoot, "google-oauth-client.json"),
    encodePackagedGoogleClientResource(
      publicClientSource,
      await resolveGoogleClientSecret(
        publicClientSource,
        mode.localDevelopment,
      ),
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    await run(
      join(desktopRoot, "node_modules/.bin/electron-builder"),
      electronBuilderArguments(repositoryRoot),
      desktopRoot,
    );
  } finally {
    await rm(releaseInputsRoot, { force: true, recursive: true });
  }
  const candidates = [
    join(output, ".electron-builder/mac-arm64/Qali.app"),
    join(output, ".electron-builder/mac/Qali.app"),
  ];
  const apps: string[] = [];
  for (const candidate of candidates) {
    if ((await lstat(candidate).catch(() => null))?.isDirectory())
      apps.push(candidate);
  }
  if (apps.length !== 1) throw new Error("OUTPUT_POLICY_RAW_APP_COUNT");
  const policy = await collectRawPackagedOutput(apps[0]!);
  const previous = await readFile(target, "utf8");
  const encoded = encodePackagedOutputPolicy(policy);
  await writeFile(target, encoded, { encoding: "utf8", mode: 0o644 });
  await rm(output, { force: true, recursive: true });
  console.log(
    `Wrote ${policy.asarEntries.length} ASAR and ${policy.resourceEntries.length} Resource output proofs` +
      (previous === encoded ? " (unchanged)." : "."),
  );
}

if (resolve(process.argv[1] ?? "") === resolve(scriptPath)) {
  await generatePackagedOutputPolicy(
    parseOutputPolicyMode(
      process.argv.slice(2),
      process.env.CI === "true" || process.env.CI === "1",
    ),
  );
}
