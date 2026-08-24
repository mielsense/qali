import { describe, expect, test } from "bun:test";

type BundleSnapshot = {
  app: {
    allowsArbitraryLoads: boolean;
    architecture: string;
    bundleId: string;
    category: string;
    minimumSystemVersion: string;
    name: string;
    version: string;
  };
  asarFiles: string[];
  executableFiles: Array<{
    architectures: string[];
    bytes: number;
    dynamicLibraries: string[];
    mode: number;
    path: string;
    sha256: string;
    signatureIdentity: { identifier: string; signature: string; teamIdentifier: string };
    signatureValid: boolean;
  }>;
  files: Array<{
    mode: number;
    path: string;
    sha256: string;
    symlink: boolean;
  }>;
  forbiddenMatches: Array<{ path: string; rule: string }>;
  inventoryIssues: Array<{ detail: string; path?: string; rule: string }>;
  resourceManifestHashesAgree: boolean;
  signatureValid: boolean;
};

const verifierModule = await import(
  "../../../scripts/desktop/lib/app-bundle-verifier"
).catch((error: unknown) => ({ error }));

function validSnapshot(): BundleSnapshot {
  return {
    app: {
      allowsArbitraryLoads: false,
      architecture: "arm64",
      bundleId: "com.qali.desktop",
      category: "public.app-category.productivity",
      minimumSystemVersion: "12.0",
      name: "Qali",
      version: "0.1.0",
    },
    asarFiles: [
      "/out/main/index.js",
      "/out/preload/index.mjs",
      "/out/renderer/index.html",
      "/package.json",
    ],
    executableFiles: [
      {
        architectures: ["arm64"],
        bytes: 1,
        dynamicLibraries: [
          "/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit",
        ],
        mode: 0o755,
        path: "Contents/MacOS/Qali",
        sha256: "a".repeat(64),
        signatureIdentity: { identifier: "com.qali.desktop", signature: "adhoc", teamIdentifier: "not set" },
        signatureValid: true,
      },
      {
        architectures: ["arm64"],
        bytes: 1,
        dynamicLibraries: ["/usr/lib/libSystem.B.dylib"],
        mode: 0o755,
        path: "Contents/Resources/bin/convex-local-backend",
        sha256: "b".repeat(64),
        signatureIdentity: { identifier: "convex-local-backend", signature: "adhoc", teamIdentifier: "not set" },
        signatureValid: true,
      },
      {
        architectures: ["arm64"],
        bytes: 1,
        dynamicLibraries: ["/usr/lib/libSystem.B.dylib"],
        mode: 0o755,
        path: "Contents/Resources/bin/convex-generate-key",
        sha256: "c".repeat(64),
        signatureIdentity: { identifier: "convex-generate-key", signature: "adhoc", teamIdentifier: "not set" },
        signatureValid: true,
      },
      {
        architectures: ["arm64"],
        bytes: 1,
        dynamicLibraries: ["/usr/lib/libSystem.B.dylib"],
        mode: 0o755,
        path: "Contents/Resources/bin/keychain-helper",
        sha256: "d".repeat(64),
        signatureIdentity: { identifier: "keychain-helper", signature: "adhoc", teamIdentifier: "not set" },
        signatureValid: true,
      },
    ],
    files: [
      {
        mode: 0o644,
        path: "Contents/Resources/app.asar",
        sha256: "e".repeat(64),
        symlink: false,
      },
      {
        mode: 0o644,
        path: "Contents/Resources/release-manifest.json",
        sha256: "f".repeat(64),
        symlink: false,
      },
    ],
    forbiddenMatches: [],
    inventoryIssues: [],
    resourceManifestHashesAgree: true,
    signatureValid: true,
  };
}

describe("final Qali.app bundle policy", () => {
  test("accepts the exact personal arm64 release shape", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    const result = verifierModule.validateBundleSnapshot(validSnapshot());
    expect(result.issues).toEqual([]);
  });

  test("parses thin/fat Mach-O evidence and only permits system or loader-relative libraries", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    expect(
      verifierModule.parseLipoArchitectures(
        "Non-fat file: Qali is architecture: arm64\n",
      ),
    ).toEqual(["arm64"]);
    expect(
      verifierModule.parseLipoArchitectures(
        "Architectures in the fat file: Qali are: x86_64 arm64\n",
      ),
    ).toEqual(["x86_64", "arm64"]);
    expect(
      verifierModule.parseOtoolLibraries(
        "Qali:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n\t@rpath/Electron Framework.framework/Electron Framework (compatibility version 1.0.0, current version 1.0.0)\n",
      ),
    ).toEqual([
      "/usr/lib/libSystem.B.dylib",
      "@rpath/Electron Framework.framework/Electron Framework",
    ]);

    const thinArm64 = Buffer.alloc(32);
    thinArm64.writeUInt32LE(0xfeedfacf, 0);
    thinArm64.writeUInt32LE(0x0100000c, 4);
    expect(verifierModule.parseMachOArchitectures(thinArm64)).toEqual([
      "arm64",
    ]);
  });

  test("classifies package text without treating the intentional auth.json guard as a credential", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    expect(
      verifierModule.findForbiddenTextMatches(
        Buffer.from(
          "auth.json PINNED_CLI_CAPABILITY_GATE_DENIED http://localhost:5173 DEEPSEEK_API_KEY QALI_RELEASE_SECRET_CANARY",
        ),
        "Contents/Resources/app.asar",
      ),
    ).toEqual([
      { path: "Contents/Resources/app.asar", rule: "DEVELOPMENT_REFERENCE" },
      { path: "Contents/Resources/app.asar", rule: "LEGACY_PROVIDER" },
      { path: "Contents/Resources/app.asar", rule: "SECRET_CANARY" },
    ]);
  });

  test("rejects foreign architecture, undeclared execution, escapes, and mutable resources", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    const snapshot = validSnapshot();
    snapshot.app.architecture = "x64";
    snapshot.executableFiles.push({
      architectures: ["x64"],
      dynamicLibraries: ["/private/tmp/build/libbad.dylib"],
      mode: 0o777,
      path: "Contents/Resources/bin/undeclared-helper",
      sha256: "0".repeat(64),
      signatureValid: false,
    });
    snapshot.files.push({
      mode: 0o666,
      path: "Contents/Resources/escape",
      sha256: "1".repeat(64),
      symlink: true,
    });
    snapshot.files.push({
      mode: 0o600,
      path: "Contents/Resources/packaged-smoke-authority.json",
      sha256: "2".repeat(64),
      symlink: false,
    });
    snapshot.files.push({
      mode: 0o600,
      path: "Contents/Resources/packaged-smoke-build-identity.json",
      sha256: "3".repeat(64),
      symlink: false,
    });
    snapshot.signatureValid = false;

    const rules = verifierModule
      .validateBundleSnapshot(snapshot)
      .issues.map((issue: { rule: string }) => issue.rule);
    expect(rules).toContain("APP_ARCHITECTURE");
    expect(rules).toContain("EXECUTABLE_ALLOWLIST");
    expect(rules).toContain("EXECUTABLE_ARCHITECTURE");
    expect(rules).toContain("EXECUTABLE_SIGNATURE");
    expect(rules).toContain("DYNAMIC_LIBRARY_PATH");
    expect(rules).toContain("RESOURCE_SYMLINK");
    expect(rules).toContain("RESOURCE_MODE");
    expect(rules).toContain("SMOKE_AUTHORITY_IN_RELEASE");
    expect(rules).toContain("SMOKE_IDENTITY_IN_RELEASE");
    expect(rules).toContain("APP_SIGNATURE");
  });

  test("rejects source maps, tests, checkout/runtime fallbacks, legacy providers, and canaries", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    const snapshot = validSnapshot();
    snapshot.asarFiles.push(
      "/out/renderer/assets/private.js.map",
      "/out/main/index.test.js",
      "/node_modules/@qali/desktop-contracts/src/index.ts",
    );
    snapshot.forbiddenMatches.push(
      { path: "Contents/Resources/app.asar", rule: "DEVELOPMENT_REFERENCE" },
      { path: "Contents/Resources/app.asar", rule: "LEGACY_PROVIDER" },
      { path: "Contents/Resources/app.asar", rule: "SECRET_CANARY" },
    );
    snapshot.resourceManifestHashesAgree = false;

    const rules = verifierModule
      .validateBundleSnapshot(snapshot)
      .issues.map((issue: { rule: string }) => issue.rule);
    expect(rules).toContain("ASAR_SOURCE_MAP");
    expect(rules).toContain("ASAR_TEST_SOURCE");
    expect(rules).toContain("ASAR_WORKSPACE_SOURCE");
    expect(rules).toContain("DEVELOPMENT_REFERENCE");
    expect(rules).toContain("LEGACY_PROVIDER");
    expect(rules).toContain("SECRET_CANARY");
    expect(rules).toContain("RESOURCE_MANIFEST_HASH");
  });

  test("rejects any added, removed, or byte/mode-changed ASAR or Resources entry", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    const expected = [
      {
        bytes: 4,
        kind: "file",
        mode: 0o644,
        path: "app.asar",
        sha256: "a".repeat(64),
      },
      {
        bytes: 0,
        kind: "directory",
        mode: 0o755,
        path: "bin",
        sha256: null,
      },
    ];
    const actual = [
      { ...expected[0]!, mode: 0o755 },
      {
        bytes: 12,
        kind: "file",
        mode: 0o755,
        path: "injected.sh",
        sha256: "b".repeat(64),
      },
    ];

    expect(verifierModule.compareExactInventory("RESOURCE", expected, actual)).toEqual([
      {
        detail: "RESOURCE entry metadata differs from the sealed inventory",
        path: "app.asar",
        rule: "RESOURCE_INVENTORY_METADATA",
      },
      {
        detail: "RESOURCE entry is missing from the final artifact",
        path: "bin",
        rule: "RESOURCE_INVENTORY_MISSING",
      },
      {
        detail: "Unexpected RESOURCE entry is present in the final artifact",
        path: "injected.sh",
        rule: "RESOURCE_INVENTORY_UNEXPECTED",
      },
    ]);
  });

  test("rejects symlinks and executable non-Mach-O resource files", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    const snapshot = validSnapshot();
    snapshot.files.push(
      {
        mode: 0o644,
        path: "Contents/Resources/injected-link",
        sha256: "0".repeat(64),
        symlink: true,
      },
      {
        mode: 0o755,
        path: "Contents/Resources/injected-script",
        sha256: "1".repeat(64),
        symlink: false,
      },
    );
    snapshot.inventoryIssues.push({
      detail: "Unexpected RESOURCE entry is present in the final artifact",
      path: "injected-script",
      rule: "RESOURCE_INVENTORY_UNEXPECTED",
    });

    const rules = verifierModule
      .validateBundleSnapshot(snapshot)
      .issues.map((issue: { rule: string }) => issue.rule);
    expect(rules).toContain("RESOURCE_SYMLINK");
    expect(rules).toContain("NON_MACHO_EXECUTABLE");
    expect(rules).toContain("RESOURCE_INVENTORY_UNEXPECTED");
  });

  test("canonical manifest has one named self-exclusion sealed by the main bundle", () => {
    expect("error" in verifierModule).toBe(false);
    if ("error" in verifierModule) return;
    const manifest = {
      asarEntries: [],
      entries: [],
      formatVersion: 2 as const,
      inputs: {
        builderConfig: { bytes: 1, sha256: "a".repeat(64) },
        dependencyLock: { bytes: 1, sha256: "b".repeat(64) },
        desktopOutput: { entries: 0, sha256: "c".repeat(64) },
        desktopPackage: { bytes: 1, sha256: "d".repeat(64) },
      },
      resourceEntries: [],
    };
    expect(verifierModule.encodePackagedResourceManifest(manifest)).toBe(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    expect((manifest.resourceEntries as Array<{ path: string }>).some(
      (entry) => entry.path === "packaged-resource-manifest.json",
    )).toBe(false);
  });
});
