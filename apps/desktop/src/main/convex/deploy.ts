import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AppChannel } from "../identity";
import { observeOwnedSpawn } from "../processes/owned-spawn-observer";
import { drainRedactedStream, type ProcessLogEntry } from "./process-driver";

export type ConvexDeploymentRuntime = Readonly<{
  electronExecutable: string;
  esbuildExecutable?: string;
  cliEntryPath: string;
  backendProjectDirectory: string;
  runtimeModulesRoot?: string;
  nodeModulesPath: string;
  deploymentUrl: string;
  adminCredential: string;
  authChannel: AppChannel;
  schemaPhase: "expand" | "contract";
}>;

export type DeploymentSpawn = typeof nodeSpawn;

export type ConvexDeploymentSpawnSpec = Readonly<{
  command: string;
  args: string[];
  options: {
    cwd: string;
    detached: true;
    env: Record<string, string>;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
  };
}>;

const DEPLOY_TIMEOUT_MS = 120_000;

export async function configureLocalAuthEnvironment(
  runtime: Pick<
    ConvexDeploymentRuntime,
    "adminCredential" | "authChannel" | "deploymentUrl"
  >,
  fetchRequest: typeof fetch = fetch,
): Promise<void> {
  const deployment = new URL(runtime.deploymentUrl);
  if (
    deployment.protocol !== "http:" ||
    deployment.hostname !== "127.0.0.1" ||
    !deployment.port ||
    (runtime.authChannel !== "stable" &&
      runtime.authChannel !== "development" &&
      runtime.authChannel !== "test")
  ) {
    throw new Error("Convex deployment auth environment is invalid");
  }
  const response = await fetchRequest(
    `${deployment.origin}/api/update_environment_variables`,
    {
      method: "POST",
      headers: {
        Authorization: `Convex ${runtime.adminCredential}`,
        "Content-Type": "application/json",
        "Convex-Client": "qali-desktop-1.0",
      },
      body: JSON.stringify({
        changes: [
          { name: "QALI_LOCAL_AUTH_CHANNEL", value: runtime.authChannel },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error("Local calendar auth environment could not be configured");
  }
}

type DeploymentProjectInput = Pick<
  ConvexDeploymentRuntime,
  "backendProjectDirectory" | "runtimeModulesRoot" | "schemaPhase"
>;

export type PreparedConvexDeploymentProject = Readonly<{
  projectDirectory: string;
  dispose(): Promise<void>;
}>;

function assertSchemaPhase(schemaPhase: string): asserts schemaPhase is "expand" | "contract" {
  if (schemaPhase !== "expand" && schemaPhase !== "contract") {
    throw new Error("Convex deployment schema phase is invalid");
  }
}

async function copyDeployDirectory(source: string, target: string): Promise<void> {
  try {
    await cp(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: async (path) => {
        if ((await lstat(path)).isSymbolicLink()) {
          throw new Error("Convex deployable project cannot contain symbolic links");
        }
        return true;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Convex intentionally forbids environment access while evaluating schema.ts.
 * Stage only the deployable project and materialize the validated phase as a
 * static module so expand/contract selection happens before the CLI starts.
 */
export async function prepareConvexDeploymentProject(
  input: DeploymentProjectInput,
): Promise<PreparedConvexDeploymentProject> {
  assertSchemaPhase(input.schemaPhase);
  const sourceRoot = await realpath(resolve(input.backendProjectDirectory));
  const projectDirectory = await mkdtemp(join(tmpdir(), "qali-convex-deploy-"));
  try {
    await copyFile(join(sourceRoot, "package.json"), join(projectDirectory, "package.json"));
    await copyDeployDirectory(join(sourceRoot, "convex"), join(projectDirectory, "convex"));
    await copyDeployDirectory(join(sourceRoot, "vendor"), join(projectDirectory, "vendor"));
    if (input.runtimeModulesRoot) {
      const modulesRoot = await realpath(resolve(input.runtimeModulesRoot));
      await mkdir(join(projectDirectory, "node_modules"));
      for (const segments of [["convex"], ["zod"], ["@qali", "domain"]]) {
        const source = join(modulesRoot, ...segments);
        const moduleMetadata = await lstat(source);
        if (!moduleMetadata.isDirectory() || moduleMetadata.isSymbolicLink()) {
          throw new Error("Packaged Convex runtime module is invalid");
        }
        const target = join(projectDirectory, "node_modules", ...segments);
        if (segments.length > 1) {
          await mkdir(join(projectDirectory, "node_modules", segments[0]!), {
            recursive: true,
          });
        }
        await copyDeployDirectory(source, target);
      }
    }
    await writeFile(
      join(projectDirectory, "convex", "schemaPhase.ts"),
      `export const schemaPhase = "${input.schemaPhase}" as const;\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (error) {
    await rm(projectDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    projectDirectory,
    async dispose() {
      await rm(projectDirectory, { recursive: true, force: true });
    },
  };
}

export function buildConvexDeploymentSpawnSpec(
  runtime: ConvexDeploymentRuntime,
  projectDirectory = runtime.backendProjectDirectory,
): ConvexDeploymentSpawnSpec {
  const deployment = new URL(runtime.deploymentUrl);
  if (deployment.protocol !== "http:" || deployment.hostname !== "127.0.0.1" || !deployment.port) {
    throw new Error("Convex deployment target must be explicit loopback");
  }
  if (
    runtime.authChannel !== "stable" &&
    runtime.authChannel !== "development" &&
    runtime.authChannel !== "test"
  ) {
    throw new Error("Convex deployment auth channel is invalid");
  }
  assertSchemaPhase(runtime.schemaPhase);
  const childEnvironment: Record<string, string> = {
    CONVEX_SELF_HOSTED_ADMIN_KEY: runtime.adminCredential,
    CONVEX_SELF_HOSTED_URL: deployment.origin,
    CI: "1",
    ELECTRON_RUN_AS_NODE: "1",
    ...(runtime.esbuildExecutable
      ? { ESBUILD_BINARY_PATH: runtime.esbuildExecutable }
      : {}),
    LANG: "C.UTF-8",
    NODE_PATH: runtime.nodeModulesPath,
    PATH: "/usr/bin:/bin",
    QALI_LOCAL_AUTH_CHANNEL: runtime.authChannel,
  };
  return {
    command: runtime.electronExecutable,
    args: [
      runtime.cliEntryPath,
      "deploy",
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
    ],
    options: {
      cwd: projectDirectory,
      detached: true,
      env: childEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

export async function deployConvexProject(
  runtime: ConvexDeploymentRuntime,
  writeLog: (entry: ProcessLogEntry) => void,
  spawnProcess: DeploymentSpawn = nodeSpawn,
  timeoutMs = DEPLOY_TIMEOUT_MS,
): Promise<void> {
  const prepared = await prepareConvexDeploymentProject(runtime);
  try {
    const spec = buildConvexDeploymentSpawnSpec(runtime, prepared.projectDirectory);
    let child: ChildProcessWithoutNullStreams;
    try {
      observeOwnedSpawn(
        "convex-deploy-cli",
        spec.command,
        spec.args,
        spec.options.env,
      );
      child = spawnProcess(spec.command, spec.args, spec.options) as unknown as ChildProcessWithoutNullStreams;
    } finally {
      for (const key of Object.keys(spec.options.env)) spec.options.env[key] = "";
    }

    const removeStdout = drainRedactedStream(
      child.stdout,
      "stdout",
      [runtime.adminCredential],
      writeLog,
    );
    const removeStderr = drainRedactedStream(
      child.stderr,
      "stderr",
      [runtime.adminCredential],
      writeLog,
    );

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        removeStdout();
        removeStderr();
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const timeout = setTimeout(() => {
        if (child.pid && child.pid > 1) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // The captured deployment child may already have exited.
          }
        }
        settle(new Error("Convex deployment timed out"));
      }, timeoutMs);
      child.once("error", () => settle(new Error("Convex deployment could not start")));
      child.once("exit", (code) => {
        settle(code === 0 ? undefined : new Error("Convex deployment failed"));
      });
    });
  } finally {
    await prepared.dispose();
  }
}
