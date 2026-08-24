import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  commitBuildMarker,
  computeDeployableProjectDigest,
  deriveAdminCredential,
  fetchBounded,
  invalidateBuildMarker,
  readBuildMarker,
  selectRuntimeArtifactProof,
} from "../src/main/convex/bootstrap";
import type { BackendSpawn } from "../src/main/convex/process-driver";

describe("Convex bootstrap", () => {
  test("uses an elapsed-time readiness budget when connection failures return immediately", async () => {
    let now = 0;
    let attempts = 0;

    await expect(
      fetchBounded("http://127.0.0.1:3210/instance_version", {}, {
        fetch: async () => {
          attempts += 1;
          throw new Error("connection refused");
        },
        now: () => now,
        overallTimeoutMs: 10_000,
        requestTimeoutMs: 1_000,
        retryDelayMs: 100,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow("Convex readiness probe timed out");

    expect(now).toBe(10_000);
    expect(attempts).toBeGreaterThan(30);
  });

  test("uses the sealed post-signing hash for packaged Mach-O resources", () => {
    const source = {
      bytes: 100,
      path: "bin/convex-local-backend",
      sha256: "a".repeat(64),
    };
    const packaged = {
      entries: [
        {
          bytes: 120,
          path: "bin/convex-local-backend",
          sha256: "b".repeat(64),
        },
      ],
      formatVersion: 2,
    };

    expect(selectRuntimeArtifactProof(source, packaged, true)).toEqual({
      bytes: 120,
      path: "bin/convex-local-backend",
      sha256: "b".repeat(64),
    });
    expect(selectRuntimeArtifactProof(source, null, false)).toEqual(source);
    expect(() => selectRuntimeArtifactProof(source, null, true)).toThrow(
      "Packaged resource manifest is unavailable",
    );
    expect(() =>
      selectRuntimeArtifactProof(
        source,
        { entries: [], formatVersion: 2 },
        true,
      ),
    ).toThrow("Packaged resource proof is invalid");
  });

  test("invalidates the deployed build marker before restored database health is probed", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-build-marker-"));
    try {
      await commitBuildMarker({ config: root }, "desktop-schema-v1");
      await expect(readBuildMarker({ config: root })).resolves.toBe("desktop-schema-v1");
      await invalidateBuildMarker({ config: root });
      await expect(readBuildMarker({ config: root })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retains key-generator request bytes until asynchronous stdin completion", async () => {
    const instanceName = "qali-test";
    const instanceSecret = "c".repeat(64);
    const expectedRequest = JSON.stringify({ instanceName, instanceSecret });
    const expectedCredential = `${instanceName}|01${"d".repeat(72)}`;
    let requestBuffer!: Buffer;
    let completeStdin!: () => void;
    let signalStdinStarted!: () => void;
    const stdinStarted = new Promise<void>((resolvePromise) => {
      signalStdinStarted = resolvePromise;
    });
    const spawn = ((_command: string, args: readonly string[]) => {
      expect(args).toEqual([]);
      expect(JSON.stringify(args)).not.toContain(instanceSecret);
      const child = new EventEmitter() as EventEmitter & {
        stdin: EventEmitter & {
          end(chunk: Buffer, callback?: () => void): void;
        };
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal?: NodeJS.Signals): boolean;
      };
      const stdin = new EventEmitter() as EventEmitter & {
        end(chunk: Buffer, callback?: () => void): void;
      };
      stdin.end = (chunk, callback) => {
        requestBuffer = chunk;
        completeStdin = () => {
          callback?.();
          child.stdout.end(`${expectedCredential}\n`);
          child.stderr.end();
          child.emit("exit", 0, null);
        };
        signalStdinStarted();
      };
      child.stdin = stdin;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    }) as unknown as BackendSpawn;
    const keychain = {
      async get() {
        return null;
      },
      async set() {
        return undefined;
      },
    };

    const derivation = deriveAdminCredential(
      keychain,
      "/Applications/Qali.app/Contents/Resources/bin/convex-generate-key",
      instanceName,
      instanceSecret,
      spawn,
    );
    await stdinStarted;
    try {
      expect(requestBuffer.toString("utf8")).toBe(expectedRequest);
    } finally {
      completeStdin();
      await derivation.catch(() => undefined);
    }

    await expect(derivation).resolves.toBe(expectedCredential);
    expect(requestBuffer.every((byte) => byte === 0)).toBe(true);
  });

  test("sends the instance secret to the key generator only over bounded stdin", async () => {
    const instanceName = "qali-test";
    const instanceSecret = "a".repeat(64);
    const expectedCredential = `${instanceName}|01${"b".repeat(72)}`;
    let capturedArgs: readonly string[] = [];
    let capturedOptions: Record<string, unknown> = {};
    let stdin = "";
    const spawn = ((_command: string, args: readonly string[], options: Record<string, unknown>) => {
      capturedArgs = args;
      capturedOptions = options;
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal?: NodeJS.Signals): boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin.on("data", (chunk) => {
        stdin += chunk.toString("utf8");
      });
      queueMicrotask(() => {
        child.stdout.end(`${expectedCredential}\n`);
        child.stderr.end();
        child.emit("exit", 0, null);
      });
      return child;
    }) as unknown as BackendSpawn;
    const stored: Array<[string, string]> = [];
    const keychain = {
      async get() {
        return null;
      },
      async set(account: string, value: string) {
        stored.push([account, value]);
      },
    };

    await expect(deriveAdminCredential(
      keychain,
      "/Applications/Qali.app/Contents/Resources/bin/convex-generate-key",
      instanceName,
      instanceSecret,
      spawn,
    )).resolves.toBe(expectedCredential);

    expect(capturedArgs).toEqual([]);
    expect(capturedOptions).toMatchObject({
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(JSON.stringify(capturedArgs)).not.toContain(instanceSecret);
    expect(JSON.stringify(capturedOptions)).not.toContain(instanceSecret);
    expect(JSON.parse(stdin)).toEqual({ instanceName, instanceSecret });
    expect(Buffer.byteLength(stdin, "utf8")).toBeLessThanOrEqual(4_096);
    expect(stored).toEqual([["convex-admin-credential", expectedCredential]]);
  });

  test("changes the deployable project digest when a Convex source changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "qali-project-digest-"));
    try {
      await mkdir(join(root, "convex"));
      await writeFile(join(root, "package.json"), '{"name":"backend"}\n');
      await writeFile(join(root, "convex", "schema.ts"), "export default 1;\n");
      const before = await computeDeployableProjectDigest(root);

      await writeFile(join(root, "convex", "schema.ts"), "export default 2;\n");

      expect(await computeDeployableProjectDigest(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses stable relative-path ordering for the deployable project digest", async () => {
    const first = await mkdtemp(join(tmpdir(), "qali-project-digest-first-"));
    const second = await mkdtemp(join(tmpdir(), "qali-project-digest-second-"));
    try {
      for (const root of [first, second]) await mkdir(join(root, "convex"));
      await writeFile(join(first, "package.json"), '{"name":"backend"}\n');
      await writeFile(join(first, "convex", "z.ts"), "export const z = 1;\n");
      await writeFile(join(first, "convex", "a.ts"), "export const a = 1;\n");
      await writeFile(join(second, "convex", "a.ts"), "export const a = 1;\n");
      await writeFile(join(second, "convex", "z.ts"), "export const z = 1;\n");
      await writeFile(join(second, "package.json"), '{"name":"backend"}\n');

      expect(await computeDeployableProjectDigest(first)).toBe(
        await computeDeployableProjectDigest(second),
      );
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });
});
