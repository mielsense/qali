import { realpathSync } from "node:fs";
import { access, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { assertNoFileCredentials, CodexBoundaryError } from "./auth";
import {
  isQaliCapabilityProvider,
  isQaliEgressProxy,
  resolveQaliCapabilityProviderControls,
  type CodexCapabilityProviderControls,
} from "./egress-proxy";
import {
  hasCodexLoginEventSubscriber,
  type CodexLoginEventChannel,
} from "./events";
import { probeCodex } from "./locator";
import {
  proxyPolicyHash,
  sha256Bytes,
  sha256File,
  loadCodexManifest,
  validateCodexManifest,
  type CodexProviderManifest,
} from "./manifest";
import type { CodexInstallationEvidence } from "./app-server-compatibility";

export type CodexProxyBoundary = Readonly<{
  url: string;
  port: number;
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  policySha256: string;
  isClosed(): boolean;
}>;

export type CodexRuntimeBoundary = Readonly<{
  manifest: CodexProviderManifest;
  manifestPath: string;
  codexHome: string;
  cwd: string;
  phaseSchemaPaths: Readonly<{ planner: string; finalizer: string }>;
  sandboxProfilePath: string;
  proxy: CodexProxyBoundary;
  keyringHealthProbe: () => Promise<boolean>;
  loginEvents?: CodexLoginEventChannel;
}>;

export type CodexRuntimeAuthority = Readonly<{ kind: "qali-codex-runtime-authority" }>;
export type CodexReleaseAuthority = Readonly<{ kind: "qali-codex-release-authority" }>;
export type CodexAppServerContainmentAuthority = Readonly<{
  kind: "qali-codex-app-server-containment-authority";
}>;
export type CodexAppServerContainmentBoundary = Readonly<{
  boundary: CodexRuntimeBoundary;
  installation: CodexInstallationEvidence;
  manifestSha256: string;
  profileSha256: string;
  proxyIdentity: CodexProxyBoundary;
  proxyPort: number;
  proxyPolicySha256: string;
  proxyUrl: string;
}>;
export type CodexReleaseBoundary = Readonly<{
  boundary: CodexRuntimeBoundary;
  testProvider: Readonly<{ id: string; baseUrl: string; model: string }>;
  controls: CodexCapabilityProviderControls;
}>;

const RUNTIME_AUTHORITIES = new WeakMap<object, CodexRuntimeBoundary>();
const RELEASE_AUTHORITIES = new WeakMap<object, CodexReleaseBoundary>();
const APP_SERVER_CONTAINMENT_AUTHORITIES = new WeakMap<
  object,
  CodexAppServerContainmentBoundary
>();

async function applicationCodexResourceRoot(): Promise<string> {
  const developmentRoot = resolve(import.meta.dirname, "../../../resources");
  try {
    await access(join(developmentRoot, "codex-provider-manifest.json"));
    return developmentRoot;
  } catch {
    return process.resourcesPath;
  }
}

export async function createCodexRuntimeAuthority(input: Readonly<{
  codexHome: string;
  cwd: string;
  /** Ignored legacy input; phase schemas are application-owned resources. */
  schemaPath?: string;
  proxy: CodexProxyBoundary;
  keyringHealthProbe: () => Promise<boolean>;
  loginEvents: CodexLoginEventChannel;
}>): Promise<CodexRuntimeAuthority> {
  // Resolving the channel here rejects structural copies; an active subscriber
  // is required later at the exact login spawn boundary.
  hasCodexLoginEventSubscriber(input.loginEvents);
  const resourceRoot = await applicationCodexResourceRoot();
  const manifestPath = join(resourceRoot, "codex-provider-manifest.json");
  const manifest = await loadCodexManifest(manifestPath);
  const authority = Object.freeze({ kind: "qali-codex-runtime-authority" as const });
  RUNTIME_AUTHORITIES.set(authority, {
    codexHome: input.codexHome,
    cwd: input.cwd,
    proxy: input.proxy,
    keyringHealthProbe: input.keyringHealthProbe,
    loginEvents: input.loginEvents,
    manifest,
    manifestPath,
    phaseSchemaPaths: {
      planner: join(resourceRoot, "codex-planner-output.schema.json"),
      finalizer: join(resourceRoot, "codex-finalizer-output.schema.json"),
    },
    sandboxProfilePath: join(resourceRoot, manifest.sandbox.path),
  });
  return authority;
}

export function resolveCodexRuntimeAuthority(authority: CodexRuntimeAuthority): CodexRuntimeBoundary {
  const boundary = typeof authority === "object" && authority !== null
    ? RUNTIME_AUTHORITIES.get(authority)
    : undefined;
  if (!boundary) {
    throw new CodexBoundaryError("CODEX_BOUNDARY_AUTHORITY_REQUIRED", "Application-owned Codex boundary authority is required");
  }
  return {
    ...boundary,
    manifest: validateCodexManifest(structuredClone(boundary.manifest)),
  };
}

export async function createCodexReleaseAuthority(input: Readonly<{
  codexHome: string;
  cwd: string;
  /** Ignored legacy input; phase schemas are application-owned resources. */
  schemaPath?: string;
  proxy: CodexProxyBoundary;
  keyringHealthProbe: () => Promise<boolean>;
}>): Promise<CodexReleaseAuthority> {
  if (!isQaliCapabilityProvider(input.proxy)) {
    throw new CodexBoundaryError("CODEX_RELEASE_AUTHORITY_REQUIRED", "Qali-owned capability provider is required");
  }
  const controls = resolveQaliCapabilityProviderControls(input.proxy);
  const resourceRoot = await applicationCodexResourceRoot();
  const manifestPath = join(resourceRoot, "codex-provider-manifest.json");
  const manifest = await loadCodexManifest(manifestPath);
  const authority = Object.freeze({ kind: "qali-codex-release-authority" as const });
  RELEASE_AUTHORITIES.set(authority, {
    boundary: {
      codexHome: input.codexHome,
      cwd: input.cwd,
      phaseSchemaPaths: {
        planner: join(resourceRoot, "codex-planner-output.schema.json"),
        finalizer: join(resourceRoot, "codex-finalizer-output.schema.json"),
      },
      proxy: input.proxy,
      keyringHealthProbe: input.keyringHealthProbe,
      manifest,
      manifestPath,
      sandboxProfilePath: join(resourceRoot, manifest.sandbox.path),
    },
    testProvider: {
      id: controls.testProvider.id,
      baseUrl: input.proxy.url,
      model: controls.testProvider.model,
    },
    controls,
  });
  return authority;
}

export function resolveCodexReleaseAuthority(authority: CodexReleaseAuthority): CodexReleaseBoundary {
  const release = typeof authority === "object" && authority !== null
    ? RELEASE_AUTHORITIES.get(authority)
    : undefined;
  if (!release) {
    throw new CodexBoundaryError("CODEX_RELEASE_AUTHORITY_REQUIRED", "Application-owned Codex release authority is required");
  }
  return {
    boundary: {
      ...release.boundary,
      manifest: validateCodexManifest(structuredClone(release.boundary.manifest)),
    },
    testProvider: { ...release.testProvider },
    controls: release.controls,
  };
}

export function createCodexAppServerContainmentAuthority(
  runtimeAuthority: CodexRuntimeAuthority,
  installation: CodexInstallationEvidence,
): CodexAppServerContainmentAuthority {
  const boundary = resolveCodexRuntimeAuthority(runtimeAuthority);
  let canonicalBoundary: CodexRuntimeBoundary;
  try {
    canonicalBoundary = {
      ...boundary,
      codexHome: realpathSync(boundary.codexHome),
      cwd: realpathSync(boundary.cwd),
    };
  } catch {
    throw new CodexBoundaryError(
      "CODEX_CONTAINMENT_PATH_INVALID",
      "Codex app-server containment paths are unavailable",
    );
  }
  const manifest = validateCodexManifest(boundary.manifest);
  const lane = manifest.appServerCompatibility?.find((candidate) =>
    candidate.version === installation.version &&
    candidate.sha256 === installation.sha256 &&
    candidate.architecture === installation.arch &&
    candidate.format === installation.format &&
    candidate.generatedSchema.sha256 === installation.generatedSchemaSha256
  );
  if (!lane) {
    throw new CodexBoundaryError(
      "CODEX_INSTALLATION_EVIDENCE_MISMATCH",
      "Codex app-server installation evidence changed",
    );
  }
  if (
    !isQaliEgressProxy(boundary.proxy) ||
    boundary.proxy.isClosed() ||
    boundary.proxy.policySha256 !== manifest.proxy.policySha256 ||
    boundary.proxy.policySha256 !== proxyPolicyHash(
      boundary.proxy.allowedHosts,
      boundary.proxy.allowedPorts,
    ) ||
    !sameStrings(boundary.proxy.allowedHosts, manifest.proxy.allowedHosts) ||
    !sameNumbers(boundary.proxy.allowedPorts, manifest.proxy.allowedPorts)
  ) {
    throw new CodexBoundaryError(
      "CODEX_PROXY_MISMATCH",
      "Codex app-server proxy authority changed",
    );
  }
  const authority = Object.freeze({
    kind: "qali-codex-app-server-containment-authority" as const,
  });
  APP_SERVER_CONTAINMENT_AUTHORITIES.set(authority, {
    boundary: canonicalBoundary,
    installation: Object.freeze({ ...installation }),
    manifestSha256: sha256Bytes(JSON.stringify(manifest)),
    profileSha256: manifest.sandbox.sha256,
    proxyIdentity: boundary.proxy,
    proxyPort: boundary.proxy.port,
    proxyPolicySha256: manifest.proxy.policySha256,
    proxyUrl: boundary.proxy.url,
  });
  return authority;
}

export function resolveCodexAppServerContainmentAuthority(
  authority: CodexAppServerContainmentAuthority,
): CodexAppServerContainmentBoundary {
  const resolved = typeof authority === "object" && authority !== null
    ? APP_SERVER_CONTAINMENT_AUTHORITIES.get(authority)
    : undefined;
  if (!resolved) {
    throw new CodexBoundaryError(
      "CODEX_CONTAINMENT_AUTHORITY_REQUIRED",
      "Application-owned Codex app-server containment authority is required",
    );
  }
  const manifest = validateCodexManifest(structuredClone(resolved.boundary.manifest));
  if (
    sha256Bytes(JSON.stringify(manifest)) !== resolved.manifestSha256 ||
    manifest.sandbox.sha256 !== resolved.profileSha256 ||
    manifest.proxy.policySha256 !== resolved.proxyPolicySha256 ||
    resolved.boundary.proxy !== resolved.proxyIdentity ||
    resolved.boundary.proxy.port !== resolved.proxyPort ||
    resolved.boundary.proxy.url !== resolved.proxyUrl
  ) {
    throw new CodexBoundaryError(
      "CODEX_CONTAINMENT_HASH_MISMATCH",
      "Codex app-server containment evidence changed",
    );
  }
  return {
    ...resolved,
    boundary: { ...resolved.boundary, manifest },
    installation: { ...resolved.installation },
  };
}


export type VerifiedCodexBoundary = Readonly<{
  executablePath: string;
  proxyUrl: string;
  proxyEndpoint: string;
  codexHome?: string;
  cwd?: string;
}>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return JSON.stringify([...left].sort((a, b) => a - b)) === JSON.stringify([...right].sort((a, b) => a - b));
}

export async function verifyCodexRuntimeBoundary(
  boundary: CodexRuntimeBoundary,
  options: Readonly<{
    allowBlockedCapability?: boolean;
    allowCapabilityProvider?: boolean;
  }> = {},
): Promise<VerifiedCodexBoundary> {
  const manifest = validateCodexManifest(boundary.manifest);
  if (
    basename(boundary.manifestPath) !== "codex-provider-manifest.json" ||
    dirname(boundary.manifestPath) !== dirname(boundary.sandboxProfilePath)
  ) {
    throw new CodexBoundaryError("CODEX_MANIFEST_MISMATCH", "Codex manifest resource path changed");
  }
  const committedManifest = await loadCodexManifest(boundary.manifestPath);
  if (JSON.stringify(committedManifest) !== JSON.stringify(manifest)) {
    throw new CodexBoundaryError("CODEX_MANIFEST_MISMATCH", "Codex manifest differs from the committed resource");
  }
  if (manifest.capability.status !== "ready" && !options.allowBlockedCapability) {
    throw new CodexBoundaryError("CODEX_CAPABILITY_BLOCKED", "Codex capability evidence is not ready");
  }
  if (basename(boundary.sandboxProfilePath) !== manifest.sandbox.path) {
    throw new CodexBoundaryError("CODEX_SANDBOX_MISMATCH", "Codex sandbox resource path changed");
  }
  if (await sha256File(boundary.sandboxProfilePath) !== manifest.sandbox.sha256) {
    throw new CodexBoundaryError("CODEX_SANDBOX_MISMATCH", "Codex sandbox resource hash changed");
  }
  const proxy = boundary.proxy;
  if (
    (!isQaliEgressProxy(proxy) && !(options.allowCapabilityProvider && isQaliCapabilityProvider(proxy))) ||
    proxy.isClosed() ||
    !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65_535 ||
    proxy.url !== `http://127.0.0.1:${proxy.port}` ||
    proxy.policySha256 !== manifest.proxy.policySha256 ||
    proxy.policySha256 !== proxyPolicyHash(proxy.allowedHosts, proxy.allowedPorts) ||
    !sameStrings(proxy.allowedHosts, manifest.proxy.allowedHosts) ||
    !sameNumbers(proxy.allowedPorts, manifest.proxy.allowedPorts)
  ) {
    throw new CodexBoundaryError("CODEX_PROXY_MISMATCH", "Codex proxy policy or lifecycle changed");
  }
  const resourceRoot = dirname(boundary.manifestPath);
  if (
    boundary.phaseSchemaPaths?.planner !==
      join(resourceRoot, "codex-planner-output.schema.json") ||
    boundary.phaseSchemaPaths?.finalizer !==
      join(resourceRoot, "codex-finalizer-output.schema.json")
  ) {
    throw new CodexBoundaryError(
      "CODEX_SCHEMA_MISMATCH",
      "Codex phase schema resource path changed",
    );
  }
  await Promise.all([
    access(boundary.phaseSchemaPaths.planner),
    access(boundary.phaseSchemaPaths.finalizer),
  ]);
  let codexHome: string;
  let cwd: string;
  try {
    [codexHome, cwd] = await Promise.all([
      realpath(boundary.codexHome),
      realpath(boundary.cwd),
    ]);
  } catch {
    throw new CodexBoundaryError(
      "CODEX_CONTAINMENT_PATH_INVALID",
      "Codex sandbox paths are unavailable",
    );
  }
  await assertNoFileCredentials(codexHome, boundary.keyringHealthProbe);
  const entries = await readdir(cwd);
  if (entries.length !== 0) {
    throw new CodexBoundaryError("CODEX_WORK_ROOT_NOT_EMPTY", "Codex work root must be empty");
  }
  const installation = await probeCodex({
    manifest,
    boundary: {
      codexHome,
      cwd,
      schemaPath: boundary.phaseSchemaPaths.planner,
      sandboxProfilePath: boundary.sandboxProfilePath,
      proxyEndpoint: `localhost:${proxy.port}`,
    },
  });
  if (installation.readiness === "incompatible") {
    throw new CodexBoundaryError("CODEX_BINARY_INCOMPATIBLE", "Pinned Codex identity did not verify");
  }
  if (installation.readiness !== "ready" && !options.allowBlockedCapability) {
    throw new CodexBoundaryError("CODEX_CAPABILITY_BLOCKED", "Codex capability evidence is not ready");
  }
  return {
    executablePath: manifest.executable.resolvedPath,
    proxyUrl: proxy.url,
    proxyEndpoint: `localhost:${proxy.port}`,
    codexHome,
    cwd,
  };
}
