import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  collectAsarInventory,
  collectDirectoryInventory,
  compareExactInventory,
  type BundleIssue,
  type ExactInventoryEntry,
} from "./app-bundle-verifier";

export type PackagedOutputPolicy = Readonly<{
  asarEntries: readonly ExactInventoryEntry[];
  formatVersion: 1;
  resourceEntries: readonly ExactInventoryEntry[];
}>;

export function encodePackagedOutputPolicy(policy: PackagedOutputPolicy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

function validEntry(entry: unknown): entry is ExactInventoryEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const value = entry as Record<string, unknown>;
  return Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 &&
    ["directory", "file", "link"].includes(String(value.kind)) &&
    Number.isSafeInteger(value.mode) && typeof value.path === "string" &&
    value.path.length > 0 && !value.path.split("/").includes("..") &&
    (value.sha256 === null || /^[a-f0-9]{64}$/.test(String(value.sha256))) &&
    (value.unpacked === undefined || typeof value.unpacked === "boolean");
}

function sortedUnique(entries: readonly ExactInventoryEntry[]): boolean {
  return entries.every((entry, index) =>
    index === 0 || entries[index - 1]!.path < entry.path
  );
}

export function parsePackagedOutputPolicy(source: string): PackagedOutputPolicy {
  const policy = JSON.parse(source) as PackagedOutputPolicy;
  if (
    policy.formatVersion !== 1 || !Array.isArray(policy.asarEntries) ||
    !Array.isArray(policy.resourceEntries) ||
    !policy.asarEntries.every(validEntry) || !policy.resourceEntries.every(validEntry) ||
    !sortedUnique(policy.asarEntries) || !sortedUnique(policy.resourceEntries) ||
    source !== encodePackagedOutputPolicy(policy)
  ) throw new Error("PACKAGED_OUTPUT_POLICY_INVALID");
  return policy;
}

export function comparePackagedOutputPolicy(
  policy: PackagedOutputPolicy,
  actual: Pick<PackagedOutputPolicy, "asarEntries" | "resourceEntries">,
): BundleIssue[] {
  return [
    ...compareExactInventory("ASAR", policy.asarEntries, actual.asarEntries),
    ...compareExactInventory("RESOURCE", policy.resourceEntries, actual.resourceEntries),
  ];
}

export async function collectRawPackagedOutput(appPath: string): Promise<PackagedOutputPolicy> {
  const resources = resolve(appPath, "Contents/Resources");
  const byPath = (left: ExactInventoryEntry, right: ExactInventoryEntry): number =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  return {
    asarEntries: (await collectAsarInventory(resolve(resources, "app.asar"))).sort(byPath),
    formatVersion: 1,
    resourceEntries: (await collectDirectoryInventory(resources)).sort(byPath),
  };
}

export async function verifyRawPackagedOutputPolicy(
  appPath: string,
  repositoryRoot: string,
): Promise<PackagedOutputPolicy> {
  const source = await readFile(
    resolve(repositoryRoot, "apps/desktop/packaged-output-policy.json"),
    "utf8",
  );
  const policy = parsePackagedOutputPolicy(source);
  const issues = comparePackagedOutputPolicy(policy, await collectRawPackagedOutput(appPath));
  if (issues.length > 0) {
    throw new Error(issues.map(({ path, rule }) => `${rule}:${path ?? ""}`).join("\n"));
  }
  return policy;
}
