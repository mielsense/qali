import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  buildBackendSpawnSpec,
  type OwnedBackendProcess,
} from "../src/main/convex/process-driver";
import {
  ConvexSupervisor,
  type ConvexSupervisorDriver,
  type ResolvedConvexRuntime,
  type SupervisorState,
} from "../src/main/convex/supervisor";

const runtime: ResolvedConvexRuntime = {
  backendExecutable: "/Applications/Qali.app/Contents/Resources/bin/convex-local-backend",
  databaseDirectory: "/tmp/qali-test/database",
  deploymentUrl: "http://127.0.0.1:43210",
  siteUrl: "http://127.0.0.1:43211",
  instanceName: "qali-test",
  instanceSecret: "a".repeat(64),
  expectedVersion: "f4a0132",
  buildMarker: "desktop-schema-v1",
};

function fakeOwnedProcess(): OwnedBackendProcess & {
  emitExit(): void;
  stopCalls: number;
} {
  const events = new EventEmitter();
  return {
    pid: 4242,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stopCalls: 0,
    emitExit() {
      events.emit("exit", 1, null);
    },
    once: events.once.bind(events),
    async stop() {
      this.stopCalls += 1;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeDriver(
  overrides: Partial<ConvexSupervisorDriver> = {},
): ConvexSupervisorDriver & { calls: string[]; process: ReturnType<typeof fakeOwnedProcess> } {
  const calls: string[] = [];
  const process = fakeOwnedProcess();
  return {
    calls,
    process,
    async resolve() {
      calls.push("resolve");
      return runtime;
    },
    async createUpgradeBackup() {
      calls.push("backup");
    },
    async spawn() {
      calls.push("spawn");
      return process;
    },
    async probeVersion() {
      calls.push("version");
      return { status: 200, version: runtime.expectedVersion };
    },
    async deploy() {
      calls.push("deploy-expand");
    },
    async contract() {
      calls.push("deploy-contract");
    },
    async authenticateIdentity() {
      calls.push("authenticate");
      return true;
    },
    async commitBuildMarker() {
      calls.push("marker");
    },
    ...overrides,
  };
}

describe("ConvexSupervisor", () => {
  test("does not report healthy before authenticated version proof", async () => {
    const driver = fakeDriver({
      async authenticateIdentity() {
        driver.calls.push("authenticate");
        return false;
      },
    });
    const states: SupervisorState[] = [];
    const supervisor = new ConvexSupervisor(driver);
    supervisor.onState((state) => states.push(state));

    await expect(supervisor.start()).rejects.toMatchObject({
      code: "BACKEND_IDENTITY_MISMATCH",
    });
    expect(states).not.toContain("healthy");
    expect(driver.process.stopCalls).toBe(1);
  });

  test("preserves the exact failed startup stage and internal cause for safe diagnostics", async () => {
    const sourceFailure = new Error("synthetic backup source changed");
    const driver = fakeDriver({
      async createUpgradeBackup() {
        driver.calls.push("backup");
        throw sourceFailure;
      },
    });
    const states: SupervisorState[] = [];
    const supervisor = new ConvexSupervisor(driver);
    supervisor.onState((state) => states.push(state));

    await expect(supervisor.start()).rejects.toMatchObject({
      code: "BACKEND_START_FAILED",
      startupStage: "backing-up",
      cause: sourceFailure,
    });
    expect(states).toEqual(["resolving", "backing-up", "blocked"]);
    expect(driver.calls).toEqual(["resolve", "backup"]);
  });

  test("contracts only after migration and commits the marker last", async () => {
    const driver = fakeDriver();
    const supervisor = new ConvexSupervisor(driver);

    await expect(supervisor.start()).resolves.toEqual({
      deploymentUrl: runtime.deploymentUrl,
      siteUrl: runtime.siteUrl,
    });
    expect(driver.calls).toEqual([
      "resolve",
      "backup",
      "spawn",
      "version",
      "deploy-expand",
      "authenticate",
    ]);
    await supervisor.completeMigration();
    expect(driver.calls).toEqual([
      "resolve",
      "backup",
      "spawn",
      "version",
      "deploy-expand",
      "authenticate",
      "deploy-contract",
      "marker",
    ]);
    expect(supervisor.state).toBe("healthy");
  });

  test("allows schema contraction to retry after a transient deploy failure", async () => {
    let attempts = 0;
    const driver = fakeDriver({
      async contract() {
        driver.calls.push("deploy-contract");
        attempts += 1;
        if (attempts === 1) throw new Error("transient contract failure");
      },
    });
    const supervisor = new ConvexSupervisor(driver);
    await supervisor.start();

    await expect(supervisor.completeMigration()).rejects.toThrow(
      "transient contract failure",
    );
    expect(supervisor.state).toBe("healthy");

    await expect(supervisor.completeMigration()).resolves.toBeUndefined();
    expect(driver.calls.filter((call) => call === "deploy-contract")).toHaveLength(
      2,
    );
    expect(driver.calls.filter((call) => call === "marker")).toHaveLength(1);
  });

  test("uses an exact loopback, no-shell, minimal-environment backend launch", () => {
    const spec = buildBackendSpawnSpec(runtime);

    expect(spec).toMatchObject({
      command: runtime.backendExecutable,
      options: {
        cwd: runtime.databaseDirectory,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    expect(spec.args).toEqual(expect.arrayContaining([
      "--interface",
      "127.0.0.1",
      "--disable-beacon",
      "--redact-logs-to-client",
      "--instance-name",
      runtime.instanceName,
      "--instance-secret",
      runtime.instanceSecret,
    ]));
    expect(spec.options.env).toEqual({
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    });
    expect(JSON.stringify(spec).replace(runtime.instanceSecret, "<redacted>"))
      .not.toContain(runtime.instanceSecret);
  });

  test("stops only the captured owned process while draining", async () => {
    const driver = fakeDriver();
    const supervisor = new ConvexSupervisor(driver);
    await supervisor.start();

    await supervisor.drain();
    expect(supervisor.state).toBe("draining");
    await supervisor.stop();

    expect(driver.process.stopCalls).toBe(1);
    expect(supervisor.state).toBe("stopped");
  });

  test("stop invalidates and awaits a start that is resolving", async () => {
    const resolving = deferred<ResolvedConvexRuntime>();
    const driver = fakeDriver({
      async resolve() {
        driver.calls.push("resolve");
        return await resolving.promise;
      },
    });
    const states: SupervisorState[] = [];
    const supervisor = new ConvexSupervisor(driver);
    supervisor.onState((state) => states.push(state));

    const start = supervisor.start();
    await Promise.resolve();
    let stopSettled = false;
    const stop = supervisor.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    resolving.resolve(runtime);
    await expect(start).rejects.toMatchObject({ code: "BACKEND_START_FAILED" });
    await stop;
    expect(driver.calls).toEqual(["resolve"]);
    expect(states.slice(states.lastIndexOf("stopped") + 1)).not.toContain("healthy");
    expect(supervisor.state).toBe("stopped");
  });

  test("stop invalidates and awaits an in-flight restart", async () => {
    const restarting = deferred<ResolvedConvexRuntime>();
    let resolveCalls = 0;
    let restartResolving!: () => void;
    const restartStarted = new Promise<void>((resolvePromise) => {
      restartResolving = resolvePromise;
    });
    const driver = fakeDriver({
      async resolve() {
        driver.calls.push("resolve");
        resolveCalls += 1;
        if (resolveCalls === 1) return runtime;
        restartResolving();
        return await restarting.promise;
      },
    });
    const supervisor = new ConvexSupervisor(driver);
    await supervisor.start();

    driver.process.emitExit();
    await restartStarted;
    let stopSettled = false;
    const stop = supervisor.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    restarting.resolve(runtime);
    await stop;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(driver.calls.filter((call) => call === "spawn")).toHaveLength(1);
    expect(supervisor.state).toBe("stopped");
  });

  test("stop invalidates and awaits in-flight schema contraction", async () => {
    const contracting = deferred<void>();
    const driver = fakeDriver({
      async contract() {
        driver.calls.push("deploy-contract");
        await contracting.promise;
      },
    });
    const supervisor = new ConvexSupervisor(driver);
    await supervisor.start();
    const migration = supervisor.completeMigration();
    await Promise.resolve();
    let stopSettled = false;
    const stop = supervisor.stop().then(() => { stopSettled = true; });
    await Bun.sleep(0);
    expect(stopSettled).toBe(false);
    contracting.resolve();
    await expect(migration).rejects.toMatchObject({ code: "BACKEND_START_FAILED" });
    await stop;
    expect(supervisor.state).toBe("stopped");
  });

  test("rejects a launch when the captured process exits during authentication", async () => {
    const driver = fakeDriver({
      async authenticateIdentity() {
        driver.calls.push("authenticate");
        driver.process.emitExit();
        return true;
      },
    });
    const supervisor = new ConvexSupervisor(driver);

    await expect(supervisor.start()).rejects.toMatchObject({ code: "BACKEND_START_FAILED" });
    expect(driver.calls).not.toContain("marker");
    expect(supervisor.state).not.toBe("healthy");
  });

  test("rejects migration completion when the captured process exits before the marker completes", async () => {
    const driver = fakeDriver({
      async commitBuildMarker() {
        driver.calls.push("marker");
        driver.process.emitExit();
      },
    });
    const supervisor = new ConvexSupervisor(driver);

    await supervisor.start();
    await expect(supervisor.completeMigration()).rejects.toMatchObject({
      code: "BACKEND_START_FAILED",
    });
    expect(supervisor.state).not.toBe("healthy");
  });
});
