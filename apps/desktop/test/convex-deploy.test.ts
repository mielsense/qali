import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildConvexDeploymentSpawnSpec,
  configureLocalAuthEnvironment,
  prepareConvexDeploymentProject,
} from "../src/main/convex/deploy";

const runtime = {
  electronExecutable: "/Applications/Qali.app/Contents/MacOS/Qali",
  cliEntryPath: "/Applications/Qali.app/Contents/Resources/convex-cli/index.js",
  backendProjectDirectory:
    "/Applications/Qali.app/Contents/Resources/convex-backend-project",
  nodeModulesPath: "/Applications/Qali.app/Contents/Resources/node_modules",
  esbuildExecutable:
    "/Applications/Qali.app/Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild",
  deploymentUrl: "http://127.0.0.1:3410",
  adminCredential: "test-instance|01secret",
  authChannel: "test" as const,
  schemaPhase: "expand" as const,
};

describe("Convex deployment auth configuration", () => {
  test("configures only the selected local auth channel through the admin loopback API", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), ...(init ? { init } : {}) });
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    await configureLocalAuthEnvironment(runtime, fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      "http://127.0.0.1:3410/api/update_environment_variables",
    );
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Convex ${runtime.adminCredential}`,
        "Content-Type": "application/json",
        "Convex-Client": "qali-desktop-1.0",
      },
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      changes: [{ name: "QALI_LOCAL_AUTH_CHANNEL", value: "test" }],
    });
  });

  test("passes the exact local auth channel through a minimal deployment environment", () => {
    const spec = buildConvexDeploymentSpawnSpec(runtime);

    expect(spec.command).toBe(runtime.electronExecutable);
    expect(spec.args).toEqual([
      runtime.cliEntryPath,
      "deploy",
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
    ]);
    expect(spec.options).toEqual({
      cwd: runtime.backendProjectDirectory,
      detached: true,
      env: {
        CONVEX_SELF_HOSTED_ADMIN_KEY: runtime.adminCredential,
        CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3410",
        CI: "1",
        ELECTRON_RUN_AS_NODE: "1",
        ESBUILD_BINARY_PATH: runtime.esbuildExecutable,
        LANG: "C.UTF-8",
        NODE_PATH: runtime.nodeModulesPath,
        PATH: "/usr/bin:/bin",
        QALI_LOCAL_AUTH_CHANNEL: "test",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  test("accepts only explicit expand and contract schema phases", () => {
    expect(() => buildConvexDeploymentSpawnSpec({
      ...runtime,
      schemaPhase: "contract",
    })).not.toThrow();
    expect(() => buildConvexDeploymentSpawnSpec({
      ...runtime,
      schemaPhase: "unsafe" as "expand",
    })).toThrow("Convex deployment schema phase is invalid");
  });

  test("rejects an invalid local auth channel before spawning", () => {
    expect(() =>
      buildConvexDeploymentSpawnSpec({
        ...runtime,
        authChannel: "forged" as "test",
      }),
    ).toThrow("Convex deployment auth channel is invalid");
  });

  test("stages a static schema phase without exposing evaluator environment access", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "qali-deploy-source-"));
    await mkdir(join(sourceRoot, "convex"));
    await writeFile(join(sourceRoot, "package.json"), "{}\n", "utf8");
    await writeFile(
      join(sourceRoot, "convex", "schemaPhase.ts"),
      'export const schemaPhase = "contract" as const;\n',
      "utf8",
    );

    try {
      const prepared = await prepareConvexDeploymentProject({
        backendProjectDirectory: sourceRoot,
        schemaPhase: "expand",
      });
      expect(await readFile(
        join(prepared.projectDirectory, "convex", "schemaPhase.ts"),
        "utf8",
      )).toBe('export const schemaPhase = "expand" as const;\n');
      expect(await readFile(join(sourceRoot, "convex", "schemaPhase.ts"), "utf8"))
        .toBe('export const schemaPhase = "contract" as const;\n');
      await prepared.dispose();
      await expect(stat(prepared.projectDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }

    const schemaSource = await readFile(
      resolve(import.meta.dir, "../../../packages/backend/convex/schema.ts"),
      "utf8",
    );
    expect(schemaSource).not.toContain("process.env");
  });

  test("stages the verified physical Convex runtime for packaged esbuild resolution", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "qali-deploy-source-"));
    const runtimeModules = await mkdtemp(join(tmpdir(), "qali-runtime-modules-"));
    await mkdir(join(sourceRoot, "convex"));
    await mkdir(join(runtimeModules, "convex/dist"), { recursive: true });
    await mkdir(join(runtimeModules, "zod"));
    await mkdir(join(runtimeModules, "@qali/domain"), { recursive: true });
    await writeFile(join(sourceRoot, "package.json"), "{}\n", "utf8");
    await writeFile(join(sourceRoot, "convex", "schema.ts"), "export default 1;\n");
    await writeFile(join(runtimeModules, "convex/package.json"), '{"name":"convex"}\n');
    await writeFile(join(runtimeModules, "convex/dist/server.js"), "export {};\n");
    await writeFile(join(runtimeModules, "zod/package.json"), '{"name":"zod"}\n');
    await writeFile(
      join(runtimeModules, "@qali/domain/package.json"),
      '{"name":"@qali/domain"}\n',
    );

    try {
      const prepared = await prepareConvexDeploymentProject({
        backendProjectDirectory: sourceRoot,
        runtimeModulesRoot: runtimeModules,
        schemaPhase: "expand",
      });
      expect(
        await readFile(
          join(prepared.projectDirectory, "node_modules/convex/dist/server.js"),
          "utf8",
        ),
      ).toBe("export {};\n");
      expect(
        await readFile(
          join(prepared.projectDirectory, "node_modules/zod/package.json"),
          "utf8",
        ),
      ).toContain('"zod"');
      expect(
        await readFile(
          join(prepared.projectDirectory, "node_modules/@qali/domain/package.json"),
          "utf8",
        ),
      ).toContain('"@qali/domain"');
      await prepared.dispose();
    } finally {
      await Promise.all([
        rm(sourceRoot, { recursive: true, force: true }),
        rm(runtimeModules, { recursive: true, force: true }),
      ]);
    }
  });
});
