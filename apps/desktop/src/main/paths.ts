import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  createAppIdentity,
  type AppChannel,
  type AppIdentity,
  type KeychainService,
} from "./identity";

const DIRECTORY_NAMES = [
  "config",
  "database",
  "cache",
  "logs",
  "runtime",
  "backups",
  "exports",
] as const;

type QaliDirectoryName = (typeof DIRECTORY_NAMES)[number];

export type QaliPaths = Readonly<
  Record<QaliDirectoryName, string> & {
    root: string;
    codexHome: string;
    keychainService: KeychainService;
    settingsFile: string;
    writerLockDiagnostic: string;
  }
>;

type IdentityInput = AppIdentity | { channel: AppChannel; appData: string };

function isContainedBy(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return (
    childRelativePath === "" ||
    (!childRelativePath.startsWith("..") && !isAbsolute(childRelativePath))
  );
}

function assertContained(parent: string, child: string, label: string): void {
  if (!isContainedBy(parent, child)) {
    throw new Error(`${label} resolves outside the Qali data root`);
  }
}

function createContainedDirectory(
  root: string,
  name: QaliDirectoryName,
): string {
  const candidate = resolve(root, name);
  assertContained(root, candidate, name);
  mkdirSync(candidate, { recursive: true, mode: 0o700 });

  const resolved = realpathSync.native(candidate);
  assertContained(root, resolved, name);
  if (!lstatSync(resolved).isDirectory()) {
    throw new Error(`${name} is not a directory`);
  }
  chmodSync(resolved, 0o700);
  return resolved;
}

export function resolveQaliPaths(input: IdentityInput): QaliPaths {
  const identity =
    "bundleId" in input
      ? input
      : createAppIdentity(input.channel, input.appData);
  const appData = realpathSync.native(identity.appData);
  const rootCandidate = resolve(appData, identity.namespace);
  assertContained(appData, rootCandidate, "application root");
  mkdirSync(rootCandidate, { recursive: true, mode: 0o700 });

  const root = realpathSync.native(rootCandidate);
  assertContained(appData, root, "application root");
  if (!lstatSync(root).isDirectory()) {
    throw new Error("Qali application root is not a directory");
  }
  chmodSync(root, 0o700);

  const directories = Object.fromEntries(
    DIRECTORY_NAMES.map((name) => [name, createContainedDirectory(root, name)]),
  ) as Record<QaliDirectoryName, string>;
  const codexHomeCandidate = resolve(directories.config, "codex-home");
  assertContained(root, codexHomeCandidate, "Codex home");
  mkdirSync(codexHomeCandidate, { recursive: true, mode: 0o700 });
  const codexHome = realpathSync.native(codexHomeCandidate);
  assertContained(directories.config, codexHome, "Codex home");
  if (!lstatSync(codexHome).isDirectory()) {
    throw new Error("Codex home is not a directory");
  }
  chmodSync(codexHome, 0o700);

  return Object.freeze({
    root,
    ...directories,
    codexHome,
    keychainService: identity.bundleId,
    settingsFile: join(directories.config, "settings.json"),
    writerLockDiagnostic: join(directories.runtime, "writer.lock"),
  });
}
