import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

export type CodexAppServerCompatibilityEntry = Readonly<{
  compatibilityVersion: 1;
  version: string;
  sha256: string;
  format: "Mach-O 64-bit executable arm64";
  architecture: "arm64";
  generatedSchema: Readonly<{
    bundlePath: "codex_app_server_protocol.v2.schemas.json";
    sha256: string;
  }>;
}>;

export type CodexProviderManifest = Readonly<{
  formatVersion: 1;
  executable: Readonly<{
    entryPath: "/opt/homebrew/bin/codex";
    resolvedPath: string;
    version: string;
    sha256: string;
    format: string;
    architecture: "arm64";
  }>;
  discovery: Readonly<{ locations: readonly string[] }>;
  appServerCompatibility: readonly CodexAppServerCompatibilityEntry[];
  sandbox: Readonly<{ path: string; sha256: string }>;
  proxy: Readonly<{
    allowedHosts: readonly string[];
    allowedPorts: readonly number[];
    policySha256: string;
  }>;
  capability: Readonly<{
    status: "ready" | "blocked";
    toolInventory: readonly string[];
    evidenceSha256: string;
    denials: readonly CodexCapabilityDenial[];
    blockerCode?: string;
  }>;
}>;

const SHA256 = /^[a-f0-9]{64}$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CODEX_VERSION = /^codex-cli \d+\.\d+\.\d+$/;

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Bytes(await readFile(path));
}

export function proxyPolicyHash(
  hosts: readonly string[],
  ports: readonly number[],
): string {
  return sha256Bytes(JSON.stringify({
    hosts: [...hosts].map((host) => host.toLowerCase()).sort(),
    ports: [...ports].sort((a, b) => a - b),
  }));
}

export type CodexCapabilityCanaries = Readonly<{
  fileIntact: boolean;
  processAbsent: boolean;
  networkUnreached: boolean;
}>;

export type CodexCapabilityDenial = Readonly<{
  tool: string;
  terminated: boolean;
  canaries: CodexCapabilityCanaries;
}>;

function normalizeDenials(denials: readonly CodexCapabilityDenial[]): CodexCapabilityDenial[] {
  return [...denials].map((denial) => ({
    tool: denial.tool,
    terminated: denial.terminated,
    canaries: {
      fileIntact: denial.canaries.fileIntact,
      processAbsent: denial.canaries.processAbsent,
      networkUnreached: denial.canaries.networkUnreached,
    },
  })).sort((left, right) => left.tool.localeCompare(right.tool));
}

function hasCompleteDenials(inventory: readonly string[], denials: readonly CodexCapabilityDenial[]): boolean {
  const tools = [...new Set(inventory)].sort();
  const normalized = normalizeDenials(denials);
  return normalized.length === tools.length && normalized.every((denial, index) =>
    denial.tool === tools[index] &&
    denial.terminated &&
    denial.canaries.fileIntact &&
    denial.canaries.processAbsent &&
    denial.canaries.networkUnreached);
}

export function capabilityEvidenceHash(
  inventory: readonly string[],
  blockerCode?: string,
  denials: readonly CodexCapabilityDenial[] = [],
): string {
  return sha256Bytes(JSON.stringify({
    blockerCode: blockerCode ?? null,
    denials: normalizeDenials(denials),
    inventory: [...new Set(inventory)].sort(),
  }));
}

export type CodexCapabilityEvidence = Readonly<{
  toolInventory: readonly string[];
  denials: readonly CodexCapabilityDenial[];
  evidenceSha256: string;
}>;

export type CodexCapabilityAssessment =
  | Readonly<{ readiness: "ready"; toolInventory: readonly string[] }>
  | Readonly<{ readiness: "blocked-by-policy" | "incompatible"; reason: string }>;

export function assessCodexCapabilityEvidence(
  manifest: CodexProviderManifest,
  evidence: CodexCapabilityEvidence,
): CodexCapabilityAssessment {
  if (manifest.capability.status === "blocked") {
    return {
      readiness: "blocked-by-policy",
      reason: manifest.capability.blockerCode ?? "CODEX_CAPABILITY_EVIDENCE_PENDING",
    };
  }
  const observed = [...new Set(evidence.toolInventory)].sort();
  const committed = [...new Set(manifest.capability.toolInventory)].sort();
  const denials = normalizeDenials(evidence.denials);
  if (
    evidence.evidenceSha256 !== capabilityEvidenceHash(observed, undefined, denials) ||
    JSON.stringify(observed) !== JSON.stringify(committed) ||
    evidence.evidenceSha256 !== manifest.capability.evidenceSha256
  ) {
    return { readiness: "incompatible", reason: "CODEX_CAPABILITY_INVENTORY_MISMATCH" };
  }
  if (!hasCompleteDenials(observed, denials)) {
    return { readiness: "incompatible", reason: "CODEX_CAPABILITY_DENIAL_INCOMPLETE" };
  }
  return { readiness: "ready", toolInventory: observed };
}

export function validateCodexManifest(value: unknown): CodexProviderManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid Codex provider manifest");
  const candidate = value as Partial<CodexProviderManifest>;
  const executable = candidate.executable;
  const discovery = candidate.discovery;
  const compatibility = candidate.appServerCompatibility;
  const sandbox = candidate.sandbox;
  const proxy = candidate.proxy;
  const capability = candidate.capability;
  if (
    candidate.formatVersion !== 1 ||
    executable?.entryPath !== "/opt/homebrew/bin/codex" ||
    typeof executable.resolvedPath !== "string" ||
    !executable.resolvedPath.startsWith("/opt/homebrew/Caskroom/codex/") ||
    typeof executable.version !== "string" ||
    !SHA256.test(executable.sha256 ?? "") ||
    executable.architecture !== "arm64" ||
    executable.format !== "Mach-O 64-bit executable arm64" ||
    !discovery ||
    !Array.isArray(discovery.locations) ||
    discovery.locations.length === 0 ||
    !discovery.locations.every((location) =>
      typeof location === "string" &&
      isAbsolute(location) &&
      normalize(location) === location) ||
    new Set(discovery.locations).size !== discovery.locations.length ||
    !discovery.locations.includes(executable.resolvedPath) ||
    !Array.isArray(compatibility) ||
    compatibility.length === 0 ||
    !compatibility.every((entry) =>
      entry && typeof entry === "object" &&
      entry.compatibilityVersion === 1 &&
      typeof entry.version === "string" && CODEX_VERSION.test(entry.version) &&
      SHA256.test(entry.sha256 ?? "") &&
      entry.format === "Mach-O 64-bit executable arm64" &&
      entry.architecture === "arm64" &&
      entry.generatedSchema && typeof entry.generatedSchema === "object" &&
      entry.generatedSchema.bundlePath === "codex_app_server_protocol.v2.schemas.json" &&
      SHA256.test(entry.generatedSchema.sha256 ?? "")) ||
    new Set(compatibility.map((entry) => entry.sha256)).size !== compatibility.length ||
    !compatibility.some((entry) =>
      entry.version === executable.version &&
      entry.sha256 === executable.sha256 &&
      entry.format === executable.format &&
      entry.architecture === executable.architecture) ||
    typeof sandbox?.path !== "string" ||
    !SHA256.test(sandbox.sha256 ?? "") ||
    !Array.isArray(proxy?.allowedHosts) ||
    proxy.allowedHosts.length === 0 ||
    !proxy.allowedHosts.every((host) => typeof host === "string" && HOST.test(host)) ||
    !Array.isArray(proxy.allowedPorts) ||
    proxy.allowedPorts.length === 0 ||
    !proxy.allowedPorts.every((port) => Number.isInteger(port) && port === 443) ||
    !SHA256.test(proxy.policySha256 ?? "") ||
    proxy.policySha256 !== proxyPolicyHash(proxy.allowedHosts, proxy.allowedPorts) ||
    !Array.isArray(capability?.toolInventory) ||
    !capability.toolInventory.every((tool) => typeof tool === "string" && /^[a-z0-9_.:-]+$/i.test(tool)) ||
    !Array.isArray(capability.denials) ||
    !capability.denials.every((denial) =>
      denial && typeof denial === "object" &&
      typeof denial.tool === "string" && /^[a-z0-9_.:-]+$/i.test(denial.tool) &&
      typeof denial.terminated === "boolean" &&
      denial.canaries && typeof denial.canaries === "object" &&
      typeof denial.canaries.fileIntact === "boolean" &&
      typeof denial.canaries.processAbsent === "boolean" &&
      typeof denial.canaries.networkUnreached === "boolean") ||
    !["ready", "blocked"].includes(capability.status ?? "") ||
    (capability.status === "ready" && capability.blockerCode !== undefined) ||
    (capability.status === "ready" && !hasCompleteDenials(capability.toolInventory, capability.denials)) ||
    (capability.status === "blocked" && (
      typeof capability.blockerCode !== "string" ||
      capability.toolInventory.length !== 0 ||
      capability.denials.length !== 0
    )) ||
    !SHA256.test(capability.evidenceSha256 ?? "") ||
    capability.evidenceSha256 !== capabilityEvidenceHash(
      capability.toolInventory,
      capability.blockerCode,
      capability.denials,
    )
  ) {
    throw new Error("Invalid Codex provider manifest");
  }
  return Object.freeze(candidate as CodexProviderManifest);
}

export async function loadCodexManifest(path: string): Promise<CodexProviderManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  return validateCodexManifest(parsed);
}
