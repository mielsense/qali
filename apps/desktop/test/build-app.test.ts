import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const module = await import("../../../scripts/desktop/build-app").catch(
  (error: unknown) => ({ error }),
);

describe("desktop release build command", () => {
  test("rejects every host except this darwin-arm64 target", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    expect(() => module.assertReleaseHost("darwin", "arm64")).not.toThrow();
    expect(() => module.assertReleaseHost("darwin", "x64")).toThrow(
      "Qali packaging requires darwin-arm64",
    );
    expect(() => module.assertReleaseHost("linux", "arm64")).toThrow(
      "Qali packaging requires darwin-arm64",
    );
  });

  test("uses the checked-in config, directory target, arm64, and no publication", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    const repositoryRoot = resolve(import.meta.dir, "../../..");
    expect(module.electronBuilderArguments(repositoryRoot)).toEqual([
      "--config",
      resolve(repositoryRoot, "apps/desktop/electron-builder.yml"),
      "--mac",
      "dir",
      "--arm64",
      "--publish",
      "never",
    ]);
    expect(module.releasePath("/Users/example/.bun/bin/bun")).toBe(
      "/Users/example/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  test("injects the installed-app token credential without recording it in source", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    const encoded = module.encodePackagedGoogleClientResource(
      JSON.stringify({
        clientId:
          "453413974502-e9ou9i10flj1u5fttlmkpq1lftmit4n6.apps.googleusercontent.com",
      }),
      "GOCSPX-qali_test_installed_secret_1234",
    );
    expect(JSON.parse(encoded)).toEqual({
      clientId:
        "453413974502-e9ou9i10flj1u5fttlmkpq1lftmit4n6.apps.googleusercontent.com",
      clientSecret: "GOCSPX-qali_test_installed_secret_1234",
    });
    expect(() =>
      module.encodePackagedGoogleClientResource(
        JSON.stringify({
          clientId:
            "453413974502-e9ou9i10flj1u5fttlmkpq1lftmit4n6.apps.googleusercontent.com",
        }),
        undefined,
      ),
    ).toThrow("GOOGLE_OAUTH_RELEASE_SECRET_MISSING");
  });

  test("refuses to clean anything except the repository dist directory", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    const repositoryRoot = resolve(import.meta.dir, "../../..");
    expect(
      module.assertReleaseOutput(
        repositoryRoot,
        resolve(repositoryRoot, "dist"),
      ),
    ).toBe(resolve(repositoryRoot, "dist"));
    expect(() =>
      module.assertReleaseOutput(repositoryRoot, repositoryRoot),
    ).toThrow("REFUSING_UNSAFE_RELEASE_OUTPUT");
    expect(() => module.assertReleaseOutput(repositoryRoot, "/tmp")).toThrow(
      "REFUSING_UNSAFE_RELEASE_OUTPUT",
    );
  });

  test("hardens the generated plist before the final application seal", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    expect(module.plistHardeningOperations()).toEqual([
      [
        "-replace",
        "NSAppTransportSecurity.NSAllowsArbitraryLoads",
        "-bool",
        "NO",
      ],
      ["-remove", "NSAudioCaptureUsageDescription"],
      ["-remove", "NSBluetoothAlwaysUsageDescription"],
      ["-remove", "NSBluetoothPeripheralUsageDescription"],
      ["-remove", "NSCameraUsageDescription"],
      ["-remove", "NSMicrophoneUsageDescription"],
    ]);
  });

  test("signs the exact code graph deepest-to-main without deep signing", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    const plan = module.buildMacSigningPlan([...module.EXPECTED_MACH_O_PATHS]);
    expect(plan.slice(0, module.EXPECTED_MACH_O_PATHS.length)).toEqual(
      [...module.EXPECTED_MACH_O_PATHS].sort(),
    );
    expect(plan.slice(-9)).toEqual([
      "Contents/Frameworks/Electron Framework.framework",
      "Contents/Frameworks/Mantle.framework",
      "Contents/Frameworks/ReactiveObjC.framework",
      "Contents/Frameworks/Squirrel.framework",
      "Contents/Frameworks/Qali Helper (GPU).app",
      "Contents/Frameworks/Qali Helper (Plugin).app",
      "Contents/Frameworks/Qali Helper (Renderer).app",
      "Contents/Frameworks/Qali Helper.app",
      ".",
    ]);
    for (const path of plan) {
      expect(module.codesignArguments(path)).toEqual([
        "--force",
        "--sign",
        "-",
        path,
      ]);
      expect(module.codesignArguments(path)).not.toContain("--deep");
    }
  });

  test("refuses to sign when packaged executable code is missing or unexpected", () => {
    expect("error" in module).toBe(false);
    if ("error" in module) return;
    expect(() =>
      module.buildMacSigningPlan(module.EXPECTED_MACH_O_PATHS.slice(1)),
    ).toThrow("PACKAGED_CODE_INVENTORY_MISMATCH");
    expect(() =>
      module.buildMacSigningPlan([
        ...module.EXPECTED_MACH_O_PATHS,
        "Contents/Resources/injected-tool",
      ]),
    ).toThrow("PACKAGED_CODE_INVENTORY_MISMATCH");
  });

  test("verifies the checked-in exact source/resource closure before building", async () => {
    const source = await Bun.file(
      new URL("../../../scripts/desktop/build-app.ts", import.meta.url),
    ).text();
    expect(source).toContain("verifyReleaseInputAllowlist(repositoryRoot)");
    expect(
      source.indexOf("verifyReleaseInputAllowlist(repositoryRoot)"),
    ).toBeLessThan(source.indexOf('["run", "build"]'));
  });

  test("checks raw builder output before plist mutation, manifesting, or signing", async () => {
    const source = await Bun.file(
      new URL("../../../scripts/desktop/build-app.ts", import.meta.url),
    ).text();
    const policy = source.lastIndexOf(
      "verifyRawPackagedOutputPolicy(existing[0]!",
    );
    expect(policy).toBeGreaterThan(
      source.lastIndexOf("electronBuilderArguments(repositoryRoot)"),
    );
    expect(policy).toBeLessThan(
      source.lastIndexOf("hardenGeneratedPlist(existing[0]!)"),
    );
    expect(policy).toBeLessThan(
      source.lastIndexOf("sealPackagedResources(existing[0]!, sourceProof)"),
    );
  });
});
