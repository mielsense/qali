import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { QALI_KEYCHAIN_RECORDS } from "../src/main/keychain/keychain";
import {
  installedGoogleClientSecret,
  parseBuildAppMode,
} from "../../../scripts/desktop/build-app";
import { parseOutputPolicyMode } from "../../../scripts/desktop/generate-packaged-output-policy";

const repositoryRoot = resolve(import.meta.dir, "../../..");

describe("personal macOS release wiring", () => {
  test("keeps output-policy regeneration local-only when source is dirty", () => {
    expect(parseOutputPolicyMode([], false)).toEqual({
      localDevelopment: false,
    });
    expect(parseOutputPolicyMode(["--local-development"], false)).toEqual({
      localDevelopment: true,
    });
    expect(() => parseOutputPolicyMode(["--local-development"], true)).toThrow(
      "LOCAL_OUTPUT_POLICY_FORBIDDEN_IN_CI",
    );
    expect(() => parseOutputPolicyMode(["--unknown"], false)).toThrow(
      "OUTPUT_POLICY_ARGUMENT_INVALID",
    );
  });

  test("keeps the compiled Keychain helper aligned with every fixed record", async () => {
    const source = await readFile(
      resolve(repositoryRoot, "apps/desktop/native/keychain-helper/main.swift"),
      "utf8",
    );
    const binary = await readFile(
      resolve(repositoryRoot, "apps/desktop/resources/bin/keychain-helper"),
    );
    const smokeSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/smoke-packaged.ts"),
      "utf8",
    );

    for (const account of QALI_KEYCHAIN_RECORDS) {
      expect(source).toContain(`"${account}"`);
      expect(binary.includes(Buffer.from(account, "utf8"))).toBe(true);
      expect(smokeSource).toContain(`"${account}"`);
    }
  });

  test("uses the supplied Qali artwork for every app icon surface", async () => {
    const iconSvg = await readFile(
      resolve(repositoryRoot, "apps/web/public/icon.svg"),
      "utf8",
    );
    const pngs = [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
      ["icon-maskable-512.png", 512],
      ["apple-touch-icon.png", 180],
    ] as const;

    expect(iconSvg).toContain('viewBox="0 0 1024 1024"');
    expect(iconSvg).toContain('id="mainStroke"');
    expect(iconSvg).toContain('<circle cx="500" cy="500" r="248"');
    expect(iconSvg).toContain('aria-label="Qali"');

    for (const [filename, size] of pngs) {
      const png = await readFile(
        resolve(repositoryRoot, "apps/web/public", filename),
      );
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
  });

  test("declares one explicit ad-hoc-signed arm64 app directory", async () => {
    const desktopPackage = JSON.parse(
      await readFile(
        resolve(repositoryRoot, "apps/desktop/package.json"),
        "utf8",
      ),
    ) as {
      build?: unknown;
      scripts?: Record<string, string>;
      version?: string;
    };
    const builderConfig = await readFile(
      resolve(repositoryRoot, "apps/desktop/electron-builder.yml"),
      "utf8",
    );
    const viteConfig = await readFile(
      resolve(repositoryRoot, "apps/desktop/electron.vite.config.ts"),
      "utf8",
    );

    expect(desktopPackage.version).toBe("0.1.0");
    expect(desktopPackage.build).toBeUndefined();
    expect(desktopPackage.scripts?.package).toBe(
      "bun ../../scripts/desktop/build-app.ts",
    );
    expect(builderConfig).toContain("appId: com.qali.desktop");
    expect(builderConfig).toContain("productName: Qali");
    expect(builderConfig).toContain("asar: true");
    expect(builderConfig).toContain('"node_modules/convex/package.json"');
    expect(builderConfig).toContain('"node_modules/convex/dist/esm/index.js"');
    expect(builderConfig).toContain(
      '"node_modules/convex/dist/esm/server/**/*"',
    );
    expect(builderConfig).toContain(
      '"node_modules/convex/dist/esm/values/**/*"',
    );
    expect(builderConfig).toContain(
      '"node_modules/convex/dist/esm/common/**/*"',
    );
    expect(builderConfig).not.toContain('"node_modules/convex/**/*"');
    expect(builderConfig).toContain('"node_modules/zod/package.json"');
    expect(builderConfig).toContain('"node_modules/zod/index.js"');
    expect(builderConfig).toContain('"node_modules/zod/v4/**/*.js"');
    expect(builderConfig).toContain(
      "to: app.asar.unpacked/node_modules/@qali/domain/src",
    );
    expect(builderConfig).toContain('"!node_modules/**/*.map"');
    expect(builderConfig).toContain('"!node_modules/**/test/**/*"');
    expect(builderConfig).toContain('"!node_modules/**/*.{test,itest,spec}.*"');
    expect(builderConfig).toContain('"!node_modules/@qali/**/*"');
    expect(builderConfig).toContain("target: dir");
    expect(builderConfig).toContain("identity: null");
    expect(builderConfig).toContain("hardenedRuntime: false");
    expect(builderConfig).toContain("notarize: false");
    expect(builderConfig).toContain(
      "category: public.app-category.productivity",
    );
    expect(builderConfig).toContain("icon: ../web/public/icon-512.png");
    expect(builderConfig).toContain("from: ../web/public/icon-512.png");
    expect(builderConfig).toContain("to: qali-icon.png");
    expect(builderConfig).toContain("NSAllowsArbitraryLoads: false");
    expect(builderConfig).toContain("NSAllowsLocalNetworking: true");
    expect(builderConfig).toContain("publish:");
    expect(builderConfig).toContain("provider: github");
    expect(builderConfig).toContain("owner: mielsense");
    expect(builderConfig).toContain("repo: qali");
    expect(builderConfig).toContain(
      "from: ../../dist/.release-inputs/google-oauth-client.json",
    );
    expect(builderConfig).toContain("to: google-oauth-client.json");
    expect(builderConfig).not.toContain("dmg");
    expect(builderConfig).not.toContain("x64");
    expect(builderConfig).not.toContain("universal");
    expect(
      viteConfig.match(/exclude: \["@qali\/desktop-contracts"\]/g),
    ).toHaveLength(1);
    expect(viteConfig).toContain('exclude: ["@qali/desktop-contracts", "zod"]');
    expect(viteConfig).toContain('external: ["original-fs"]');
  });

  test("exposes deterministic root package, verification, and smoke commands", async () => {
    const rootPackage = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(rootPackage.scripts?.["desktop:package"]).toBe(
      "bun scripts/desktop/build-app.ts",
    );
    expect(rootPackage.scripts?.["desktop:package:local"]).toBe(
      "bun scripts/desktop/build-app.ts --local-development",
    );
    expect(rootPackage.scripts?.["desktop:release:mac"]).toBe(
      "bun scripts/desktop/release-macos.ts",
    );
    expect(rootPackage.scripts?.["desktop:verify-app"]).toBe(
      "bun scripts/desktop/verify-app.ts",
    );
    expect(rootPackage.scripts?.["desktop:verify-app:local"]).toBe(
      "bun scripts/desktop/verify-app.ts --local-development",
    );
    expect(rootPackage.scripts?.["desktop:smoke-packaged"]).toBe(
      "bun scripts/desktop/smoke-packaged.ts",
    );
    expect(rootPackage.scripts?.["desktop:smoke-packaged:local"]).toBe(
      "bun scripts/desktop/smoke-packaged.ts --local-development",
    );
  });

  test("keeps dirty packaging explicit, local-only, and bound to the installed OAuth client", () => {
    expect(parseBuildAppMode([], false)).toEqual({ localDevelopment: false });
    expect(parseBuildAppMode(["--local-development"], false)).toEqual({
      localDevelopment: true,
    });
    expect(() => parseBuildAppMode(["--local-development"], true)).toThrow(
      "LOCAL_DEVELOPMENT_PACKAGE_FORBIDDEN_IN_CI",
    );
    expect(() => parseBuildAppMode(["--unknown"], false)).toThrow(
      "BUILD_APP_ARGUMENT_INVALID",
    );

    const clientId = `${"4".repeat(12)}-${"a".repeat(16)}.apps.googleusercontent.com`;
    const clientSecret = `GOCSPX-${"b".repeat(16)}`;
    expect(
      installedGoogleClientSecret(
        JSON.stringify({ clientId }),
        JSON.stringify({ clientId, clientSecret }),
      ),
    ).toBe(clientSecret);
    expect(() =>
      installedGoogleClientSecret(
        JSON.stringify({ clientId }),
        JSON.stringify({
          clientId: `${"5".repeat(12)}-${"c".repeat(16)}.apps.googleusercontent.com`,
          clientSecret,
        }),
      ),
    ).toThrow("INSTALLED_GOOGLE_OAUTH_CLIENT_MISMATCH");
  });

  test("declares a separate immutable signed-release artifact stage", async () => {
    const releaseConfig = await readFile(
      resolve(repositoryRoot, "apps/desktop/electron-builder.release.yml"),
      "utf8",
    );
    const mainEntitlements = await readFile(
      resolve(repositoryRoot, "apps/desktop/build/entitlements.mac.plist"),
      "utf8",
    );
    const inheritedEntitlements = await readFile(
      resolve(
        repositoryRoot,
        "apps/desktop/build/entitlements.mac.inherit.plist",
      ),
      "utf8",
    );

    expect(releaseConfig).toContain("extends: ./electron-builder.yml");
    expect(releaseConfig).toContain("target: dmg");
    expect(releaseConfig).toContain("target: zip");
    expect(releaseConfig).toContain(
      "artifactName: Qali-${version}-${arch}.${ext}",
    );
    expect(mainEntitlements).toContain("com.apple.security.cs.allow-jit");
    expect(mainEntitlements).toContain(
      "com.apple.security.cs.allow-unsigned-executable-memory",
    );
    expect(mainEntitlements).not.toContain(
      "com.apple.security.cs.allow-dyld-environment-variables",
    );
    expect(inheritedEntitlements).not.toContain(
      "com.apple.security.cs.disable-library-validation",
    );
  });

  test("keeps validation read-only and isolates release publication authority", async () => {
    const ci = await readFile(
      resolve(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    const release = await readFile(
      resolve(repositoryRoot, ".github/workflows/release-macos.yml"),
      "utf8",
    );
    const actionPin = /uses:\s+[^\s@]+@[0-9a-f]{40}(?:\s|$)/g;

    expect(ci).toContain("permissions:\n  contents: read");
    expect(ci).not.toContain("pull_request_target:");
    expect(ci.match(actionPin)).toHaveLength(4);
    expect(release).toContain("environment: macos-release-candidate");
    expect(release).toContain("environment: github-release");
    expect(release).toContain("cancel-in-progress: false");
    expect(release).toContain("needs: candidate");
    expect(release).toContain("sha256sum --check SHA256SUMS.txt");
    expect(release).toContain("Refuse to overwrite an existing release");
    expect(release.match(actionPin)).toHaveLength(5);
  });

  test("requires the release-owned Google OAuth client before packaging", async () => {
    const buildSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/build-app.ts"),
      "utf8",
    );
    const policySource = await readFile(
      resolve(
        repositoryRoot,
        "scripts/desktop/generate-packaged-output-policy.ts",
      ),
      "utf8",
    );
    expect(buildSource).toContain('"resources/google-oauth-client.json"');
    expect(buildSource).toContain("QALI_GOOGLE_OAUTH_CLIENT_SECRET");
    expect(buildSource).toContain(".release-inputs");
    expect(policySource).toContain("encodePackagedGoogleClientResource");
    expect(policySource).toContain("resolveGoogleClientSecret");
    expect(policySource).toContain("mode.localDevelopment");
    expect(policySource).toContain(".release-inputs");
  });

  test("seals the physical packaged esbuild child used for local deployment", async () => {
    const buildSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/build-app.ts"),
      "utf8",
    );

    expect(buildSource).toContain("createPackagedResourceManifest");
    expect(buildSource).not.toContain('"--deep"');
    const verifierSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/lib/app-bundle-verifier.ts"),
      "utf8",
    );
    expect(verifierSource).toContain(
      '"app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild"',
    );
    expect(verifierSource).toContain(
      'exclude: new Set(["packaged-resource-manifest.json"])',
    );
    expect(verifierSource).toContain("RESOURCE_MANIFEST_CANONICAL");
  });

  test("never uses deep signing while retaining deep final verification", async () => {
    const buildSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/build-app.ts"),
      "utf8",
    );
    const smokeSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/smoke-packaged.ts"),
      "utf8",
    );
    const verifierSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/lib/app-bundle-verifier.ts"),
      "utf8",
    );
    expect(buildSource).not.toContain('"--deep"');
    expect(smokeSource).not.toContain('"--deep"');
    expect(verifierSource).toContain('"--deep"');
  });

  test("hashes the physical ASAR through Electron's unpatched filesystem", async () => {
    const mainSource = await readFile(
      resolve(repositoryRoot, "apps/desktop/src/main/index.ts"),
      "utf8",
    );

    expect(mainSource).toContain('from "original-fs"');
    expect(mainSource).toContain("packaged-smoke-build-identity.json");
    expect(mainSource).toContain("readBuildIdentity:");
    expect(mainSource).not.toContain("isSmokeBuild: true");
    expect(mainSource).not.toContain("writeFileSync");
    expect(mainSource).toContain(
      'originalReadFileSync(join(process.resourcesPath, "app.asar"))',
    );
    expect(mainSource).toContain('let lastConvexProgress = "not-created"');
    expect(mainSource).toMatch(
      /state !== "blocked"\s*&&\s*state !== "draining"/,
    );
    expect(mainSource).toContain("`failed:${lastConvexProgress}:");
  });

  test("publishes packaged smoke readiness with a same-directory atomic rename", async () => {
    const mainSource = await readFile(
      resolve(repositoryRoot, "apps/desktop/src/main/index.ts"),
      "utf8",
    );
    expect(mainSource).toContain("packaged-smoke-ready.tmp");
    expect(mainSource).toContain(
      "await rename(smokeMarkerTemporary, packagedSmoke.readyMarker)",
    );
  });

  test("uses the contract bridge version in packaged smoke and release evidence", async () => {
    const smokeSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/smoke-packaged.ts"),
      "utf8",
    );
    const verifierSource = await readFile(
      resolve(repositoryRoot, "scripts/desktop/verify-app.ts"),
      "utf8",
    );

    expect(smokeSource).toContain(
      'import { BRIDGE_VERSION } from "@qali/desktop-contracts"',
    );
    expect(smokeSource).toContain("value.bridgeVersion === BRIDGE_VERSION");
    expect(verifierSource).toContain(
      'import { BRIDGE_VERSION } from "@qali/desktop-contracts"',
    );
    expect(verifierSource).toContain("bridgeVersion: BRIDGE_VERSION");
  });

  test("ships one closed arm64 Codex App Server compatibility lane", async () => {
    const manifest = JSON.parse(
      await readFile(
        resolve(
          repositoryRoot,
          "apps/desktop/resources/codex-provider-manifest.json",
        ),
        "utf8",
      ),
    ) as {
      discovery: { locations: string[] };
      appServerCompatibility: Array<{
        compatibilityVersion: number;
        version: string;
        sha256: string;
        format: string;
        architecture: string;
        generatedSchema: { bundlePath: string; sha256: string };
      }>;
    };

    expect(manifest.discovery.locations).toEqual([
      "/opt/homebrew/Caskroom/codex/0.149.1/bin/codex",
    ]);
    expect(manifest.appServerCompatibility).toEqual([
      {
        compatibilityVersion: 1,
        version: "codex-cli 0.149.1",
        sha256:
          "f0d8762236594359b60cfbe17f4c7e945a3ce8d1c91e74778838c968d250fb6c",
        format: "Mach-O 64-bit executable arm64",
        architecture: "arm64",
        generatedSchema: {
          bundlePath: "codex_app_server_protocol.v2.schemas.json",
          sha256:
            "9b3de71a5a2ffc980b792a18aa8f8dec3f85f48829560222a0264fe494b679a9",
        },
      },
    ]);
  });

  test("keeps contributor and release guidance aligned with the production desktop", async () => {
    const repositoryGuide = await readFile(
      resolve(repositoryRoot, "AGENTS.md"),
      "utf8",
    );
    const architecture = await readFile(
      resolve(repositoryRoot, "docs/architecture.md"),
      "utf8",
    );
    const releaseRunbook = await readFile(
      resolve(repositoryRoot, "docs/desktop/release-macos.md"),
      "utf8",
    );
    const readme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
    const privacy = await readFile(
      resolve(repositoryRoot, "docs/desktop/privacy-and-diagnostics.md"),
      "utf8",
    );

    expect(repositoryGuide).toContain("Prove the changed risk");
    expect(repositoryGuide).toContain("Never use the installed Qali data root");
    expect(repositoryGuide).toContain("apps/desktop/src/main/index.ts");
    expect(architecture).toContain("Renderer → preload → Electron main");
    expect(architecture).toContain("Google Calendar");
    expect(releaseRunbook).toContain("QALI_GOOGLE_OAUTH_CLIENT_SECRET");
    expect(releaseRunbook).toContain("MACOS_CERTIFICATE_BASE64");
    expect(releaseRunbook).toContain("SHA256SUMS.txt");
    expect(releaseRunbook).not.toContain("GOCSPX-");
    expect(readme).toContain("up to eight Google accounts");
    expect(readme).not.toContain("assistant-disabled");
    expect(privacy).not.toContain("no updater");
  });
});
