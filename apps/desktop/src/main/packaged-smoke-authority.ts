import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export type PackagedSmokeAuthority = Readonly<{
  applicationAsarSha256: string;
  formatVersion: 1;
  nonce: string;
  phase: "seed" | "verify";
  root: string;
}>;

export type ValidatedPackagedSmokeAuthority = Readonly<{
  appData: string;
  channel: "test";
  nonce: string;
  phase: "seed" | "verify";
  readyMarker: string;
  root: string;
}>;

const SENTINEL_FILE = ".qali-packaged-smoke-authority.json";
const MAX_AUTHORITY_BYTES = 4_096;
const SMOKE_BUILD_KIND = "qali-packaged-smoke-build";

function rejected(): Error {
  return new Error("PACKAGED_SMOKE_AUTHORITY_REJECTED");
}

function isContainedBy(parent: string, child: string): boolean {
  const candidate = relative(parent, child);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSentinel(source: string): Omit<PackagedSmokeAuthority, "root"> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw rejected();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "applicationAsarSha256,formatVersion,nonce,phase" ||
    value.formatVersion !== 1 ||
    typeof value.applicationAsarSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.applicationAsarSha256) ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.nonce) ||
    (value.phase !== "seed" && value.phase !== "verify")
  ) {
    throw rejected();
  }
  return {
    applicationAsarSha256: value.applicationAsarSha256,
    formatVersion: 1,
    nonce: value.nonce,
    phase: value.phase,
  };
}

function parseBuildIdentity(source: string): Readonly<{
  applicationAsarSha256: string;
  nonce: string;
}> {
  if (Buffer.byteLength(source, "utf8") > MAX_AUTHORITY_BYTES) throw rejected();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw rejected();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "applicationAsarSha256,formatVersion,kind,nonce" ||
    value.formatVersion !== 1 ||
    value.kind !== SMOKE_BUILD_KIND ||
    typeof value.applicationAsarSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.applicationAsarSha256) ||
    typeof value.nonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.nonce)
  ) {
    throw rejected();
  }
  return {
    applicationAsarSha256: value.applicationAsarSha256,
    nonce: value.nonce,
  };
}

export async function validatePackagedSmokeAuthority(
  value: PackagedSmokeAuthority,
  evidence: Readonly<{
    applicationAsarSha256: string;
    repositoryRoot: string;
  }>,
): Promise<ValidatedPackagedSmokeAuthority> {
  if (
    value.formatVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.nonce) ||
    !/^[a-f0-9]{64}$/.test(value.applicationAsarSha256) ||
    value.applicationAsarSha256 !== evidence.applicationAsarSha256 ||
    !isAbsolute(value.root)
  ) {
    throw rejected();
  }

  let root: string;
  let temporaryRoot: string;
  let repositoryRoot: string;
  try {
    root = realpathSync.native(resolve(value.root));
    temporaryRoot = realpathSync.native(tmpdir());
    repositoryRoot = realpathSync.native(resolve(evidence.repositoryRoot));
  } catch {
    throw rejected();
  }
  if (
    !isContainedBy(temporaryRoot, root) ||
    isContainedBy(repositoryRoot, root) ||
    !basename(root).startsWith("qali-packaged-smoke-")
  ) {
    throw rejected();
  }

  const rootMetadata = await lstat(root).catch(() => null);
  if (
    rootMetadata === null ||
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    (rootMetadata.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && rootMetadata.uid !== process.getuid())
  ) {
    throw rejected();
  }

  const sentinelPath = join(root, SENTINEL_FILE);
  const sentinelMetadata = await lstat(sentinelPath).catch(() => null);
  if (
    sentinelMetadata === null ||
    !sentinelMetadata.isFile() ||
    sentinelMetadata.isSymbolicLink() ||
    sentinelMetadata.size < 1 ||
    sentinelMetadata.size > MAX_AUTHORITY_BYTES ||
    (sentinelMetadata.mode & 0o077) !== 0
  ) {
    throw rejected();
  }
  const sentinel = parseSentinel(await readFile(sentinelPath, "utf8"));
  if (
    sentinel.nonce !== value.nonce ||
    sentinel.applicationAsarSha256 !== value.applicationAsarSha256 ||
    sentinel.phase !== value.phase
  ) {
    throw rejected();
  }

  return Object.freeze({
    appData: root,
    channel: "test",
    nonce: value.nonce,
    phase: value.phase,
    readyMarker: join(root, "Qali Test", "runtime", "packaged-smoke-ready.json"),
    root,
  });
}

export function parsePackagedSmokeAuthority(
  source: string,
): PackagedSmokeAuthority {
  if (Buffer.byteLength(source, "utf8") > MAX_AUTHORITY_BYTES) throw rejected();
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw rejected();
  }
  if (!isRecord(value) || typeof value.root !== "string") throw rejected();
  const sentinel = parseSentinel(
    JSON.stringify({
      applicationAsarSha256: value.applicationAsarSha256,
      formatVersion: value.formatVersion,
      nonce: value.nonce,
      phase: value.phase,
    }),
  );
  if (
    Object.keys(value).sort().join(",") !==
    "applicationAsarSha256,formatVersion,nonce,phase,root"
  ) {
    throw rejected();
  }
  return Object.freeze({ ...sentinel, root: value.root });
}

export async function loadPackagedSmokeAuthority(options: Readonly<{
  applicationAsarSha256: string;
  isPackaged: boolean;
  readAuthority(): string;
  readBuildIdentity(): string;
  repositoryRoot: string;
}>): Promise<ValidatedPackagedSmokeAuthority | null> {
  if (!options.isPackaged) throw rejected();
  let buildIdentitySource: string;
  let source: string;
  try {
    buildIdentitySource = options.readBuildIdentity();
    source = options.readAuthority();
  } catch {
    throw rejected();
  }
  const buildIdentity = parseBuildIdentity(buildIdentitySource);
  const authority = parsePackagedSmokeAuthority(source);
  if (
    buildIdentity.applicationAsarSha256 !== options.applicationAsarSha256 ||
    buildIdentity.applicationAsarSha256 !== authority.applicationAsarSha256 ||
    buildIdentity.nonce !== authority.nonce
  ) {
    throw rejected();
  }
  return await validatePackagedSmokeAuthority(
    authority,
    {
      applicationAsarSha256: options.applicationAsarSha256,
      repositoryRoot: options.repositoryRoot,
    },
  );
}
