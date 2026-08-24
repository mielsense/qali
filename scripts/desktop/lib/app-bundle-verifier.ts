export type BundleSnapshot = Readonly<{
  app: Readonly<{
    allowsArbitraryLoads: boolean;
    architecture: string;
    bundleId: string;
    category: string;
    minimumSystemVersion: string;
    name: string;
    version: string;
  }>;
  asarFiles: readonly string[];
  executableFiles: readonly Readonly<{
    architectures: readonly string[];
    bytes: number;
    dynamicLibraries: readonly string[];
    mode: number;
    path: string;
    sha256: string;
    signatureIdentity: Readonly<{
      identifier: string;
      signature: string;
      teamIdentifier: string;
    }>;
    signatureValid: boolean;
  }>[];
  files: readonly Readonly<{
    escapesBundle?: boolean;
    mode: number;
    path: string;
    sha256: string;
    symlink: boolean;
  }>[];
  forbiddenMatches: readonly Readonly<{ path: string; rule: string }>[];
  inventoryIssues: readonly BundleIssue[];
  resourceManifestHashesAgree: boolean;
  signatureValid: boolean;
}>;

export type BundleIssue = Readonly<{
  detail: string;
  path?: string;
  rule: string;
}>;

export type BundleValidation = Readonly<{
  issues: readonly BundleIssue[];
}>;

export type ExactInventoryEntry = Readonly<{
  bytes: number;
  kind: "directory" | "file" | "link";
  mode: number;
  path: string;
  sha256: string | null;
  unpacked?: boolean;
}>;

export type PackagingInputProofs = Readonly<{
  builderConfig: Readonly<{ bytes: number; sha256: string }>;
  dependencyLock: Readonly<{ bytes: number; sha256: string }>;
  desktopOutput: Readonly<{ entries: number; sha256: string }>;
  desktopPackage: Readonly<{ bytes: number; sha256: string }>;
  releaseInputs: Readonly<{
    entries: number;
    manifest: Readonly<{ bytes: number; sha256: string }>;
    sha256: string;
  }>;
  source: Readonly<{ patchSha256: string; revision: string }>;
}>;

export type PackagedResourceManifest = Readonly<{
  asarEntries: readonly ExactInventoryEntry[];
  entries: readonly Readonly<{
    bytes: number;
    mode: number;
    path: string;
    sha256: string;
  }>[];
  formatVersion: 2;
  inputs: PackagingInputProofs;
  resourceEntries: readonly ExactInventoryEntry[];
}>;

export function encodePackagedResourceManifest(
  manifest: PackagedResourceManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export const EXPECTED_MACH_O_PATHS = [
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libGLESv2.dylib",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib",
  "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib",
  "Contents/Frameworks/Mantle.framework/Versions/A/Mantle",
  "Contents/Frameworks/Qali Helper (GPU).app/Contents/MacOS/Qali Helper (GPU)",
  "Contents/Frameworks/Qali Helper (Plugin).app/Contents/MacOS/Qali Helper (Plugin)",
  "Contents/Frameworks/Qali Helper (Renderer).app/Contents/MacOS/Qali Helper (Renderer)",
  "Contents/Frameworks/Qali Helper.app/Contents/MacOS/Qali Helper",
  "Contents/Frameworks/ReactiveObjC.framework/Versions/A/ReactiveObjC",
  "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt",
  "Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel",
  "Contents/MacOS/Qali",
  "Contents/Resources/app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild",
  "Contents/Resources/bin/convex-generate-key",
  "Contents/Resources/bin/convex-local-backend",
  "Contents/Resources/bin/keychain-helper",
] as const;
const EXPECTED_MACH_O_SET = new Set<string>(EXPECTED_MACH_O_PATHS);

const FORBIDDEN_TEXT_RULES = [
  {
    pattern:
      /(?:https?:\/\/(?:localhost|127\.0\.0\.1):(?:3000|4173|5173|5174)|VITE_DEV_SERVER_URL|\/Users\/[^/\s]+\/|(?:^|["'\s])\.\.\/\.\.\/packages\/backend)/i,
    rule: "DEVELOPMENT_REFERENCE",
  },
  {
    pattern: /(?:DEEPSEEK_API_KEY|api\.deepseek\.com|OPENAI_API_KEY)/i,
    rule: "LEGACY_PROVIDER",
  },
  {
    pattern:
      /QALI_(?:RELEASE|GOOGLE|CODEX|JWT|CONVEX_ADMIN|CONVEX_INSTANCE)_SECRET_CANARY/i,
    rule: "SECRET_CANARY",
  },
] as const;

export function parseLipoArchitectures(output: string): string[] {
  const thin = output.match(/\bis architecture:\s*([^\s]+)/);
  if (thin) return [thin[1]!];
  const fat = output.match(/\bare:\s*([^\n]+)/);
  if (!fat) return [];
  return fat[1]!.trim().split(/\s+/).filter(Boolean);
}

const MACH_O_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;

type MachOSlice = Readonly<{
  architecture: string;
  offset: number;
  size: number;
}>;

function architectureName(cpuType: number): string {
  switch (cpuType >>> 0) {
    case 0x0100000c:
      return "arm64";
    case 0x01000007:
      return "x86_64";
    case 0x0000000c:
      return "arm";
    case 0x00000007:
      return "i386";
    default:
      return `cpu-${(cpuType >>> 0).toString(16)}`;
  }
}

function machOSlices(bytes: Uint8Array): MachOSlice[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength < 8) return [];

  const littleMagic = buffer.readUInt32LE(0);
  const bigMagic = buffer.readUInt32BE(0);
  if (littleMagic === MACH_O_MAGIC_64) {
    return [
      {
        architecture: architectureName(buffer.readUInt32LE(4)),
        offset: 0,
        size: buffer.byteLength,
      },
    ];
  }
  if (bigMagic === MACH_O_MAGIC_64) {
    return [
      {
        architecture: architectureName(buffer.readUInt32BE(4)),
        offset: 0,
        size: buffer.byteLength,
      },
    ];
  }

  const isFat = [FAT_MAGIC, FAT_CIGAM, FAT_MAGIC_64, FAT_CIGAM_64].includes(
    bigMagic,
  );
  if (!isFat) return [];

  const littleEndian = bigMagic === FAT_CIGAM || bigMagic === FAT_CIGAM_64;
  const is64 = bigMagic === FAT_MAGIC_64 || bigMagic === FAT_CIGAM_64;
  const read32 = (offset: number) =>
    littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const read64 = (offset: number) =>
    Number(
      littleEndian
        ? buffer.readBigUInt64LE(offset)
        : buffer.readBigUInt64BE(offset),
    );
  const count = read32(4);
  const entrySize = is64 ? 32 : 20;
  if (count > 16 || 8 + count * entrySize > buffer.byteLength) return [];

  const slices: MachOSlice[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 8 + index * entrySize;
    const offset = is64 ? read64(entryOffset + 8) : read32(entryOffset + 8);
    const size = is64 ? read64(entryOffset + 16) : read32(entryOffset + 12);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size <= 0 ||
      offset + size > buffer.byteLength
    ) {
      return [];
    }
    slices.push({
      architecture: architectureName(read32(entryOffset)),
      offset,
      size,
    });
  }
  return slices;
}

export function parseMachOArchitectures(bytes: Uint8Array): string[] {
  return machOSlices(bytes).map(({ architecture }) => architecture);
}

export function parseMachODynamicLibraries(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const libraryCommands = new Set([0x0c, 0x18, 0x1f, 0x20, 0x23]);
  const libraries = new Set<string>();

  for (const slice of machOSlices(bytes)) {
    if (slice.size < 32) continue;
    const littleEndian = buffer.readUInt32LE(slice.offset) === MACH_O_MAGIC_64;
    const read32 = (offset: number) =>
      littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const commandCount = read32(slice.offset + 16);
    const commandsSize = read32(slice.offset + 20);
    const commandsEnd = slice.offset + 32 + commandsSize;
    if (
      commandCount > 16_384 ||
      commandsEnd > slice.offset + slice.size ||
      commandsEnd > buffer.byteLength
    ) {
      continue;
    }

    let commandOffset = slice.offset + 32;
    for (let index = 0; index < commandCount; index += 1) {
      if (commandOffset + 8 > commandsEnd) break;
      const commandType = read32(commandOffset) & 0x7fffffff;
      const commandSize = read32(commandOffset + 4);
      if (commandSize < 8 || commandOffset + commandSize > commandsEnd) break;
      if (libraryCommands.has(commandType) && commandSize >= 24) {
        const nameOffset = read32(commandOffset + 8);
        const nameStart = commandOffset + nameOffset;
        const nameEndLimit = commandOffset + commandSize;
        if (nameStart >= commandOffset && nameStart < nameEndLimit) {
          let nameEnd = nameStart;
          while (nameEnd < nameEndLimit && buffer[nameEnd] !== 0) nameEnd += 1;
          const name = buffer.toString("utf8", nameStart, nameEnd).trim();
          if (name) libraries.add(name);
        }
      }
      commandOffset += commandSize;
    }
  }

  return [...libraries].sort();
}

export function parseOtoolLibraries(output: string): string[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0] ?? "")
    .filter(Boolean);
}

export function findForbiddenTextMatches(
  bytes: Uint8Array,
  path: string,
): Array<{ path: string; rule: string }> {
  const source = Buffer.from(bytes).toString("utf8");
  return FORBIDDEN_TEXT_RULES.flatMap(({ pattern, rule }) =>
    pattern.test(source) ? [{ path, rule }] : [],
  );
}

export function compareExactInventory(
  label: "ASAR" | "RESOURCE",
  expected: readonly ExactInventoryEntry[],
  actual: readonly ExactInventoryEntry[],
): BundleIssue[] {
  const issues: BundleIssue[] = [];
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  if (
    expectedByPath.size !== expected.length ||
    actualByPath.size !== actual.length
  ) {
    issue(
      issues,
      `${label}_INVENTORY_DUPLICATE`,
      `${label} inventory contains duplicate paths`,
    );
    return issues;
  }
  for (const entry of expected) {
    const candidate = actualByPath.get(entry.path);
    if (!candidate) {
      issue(
        issues,
        `${label}_INVENTORY_MISSING`,
        `${label} entry is missing from the final artifact`,
        entry.path,
      );
    } else if (
      candidate.bytes !== entry.bytes ||
      candidate.kind !== entry.kind ||
      candidate.mode !== entry.mode ||
      candidate.sha256 !== entry.sha256 ||
      candidate.unpacked !== entry.unpacked
    ) {
      issue(
        issues,
        `${label}_INVENTORY_METADATA`,
        `${label} entry metadata differs from the sealed inventory`,
        entry.path,
      );
    }
  }
  for (const entry of actual) {
    if (!expectedByPath.has(entry.path)) {
      issue(
        issues,
        `${label}_INVENTORY_UNEXPECTED`,
        `Unexpected ${label} entry is present in the final artifact`,
        entry.path,
      );
    }
  }
  return issues;
}

function issue(
  issues: BundleIssue[],
  rule: string,
  detail: string,
  path?: string,
): void {
  issues.push({ detail, ...(path ? { path } : {}), rule });
}

function executableAllowed(path: string): boolean {
  return EXPECTED_MACH_O_SET.has(path);
}

function dynamicLibraryAllowed(path: string): boolean {
  return (
    path.startsWith("/System/Library/") ||
    path.startsWith("/usr/lib/") ||
    path.startsWith("@rpath/") ||
    path.startsWith("@loader_path/") ||
    path.startsWith("@executable_path/") ||
    path === "./libEGL.dylib" ||
    path === "./libGLESv2.dylib"
  );
}

export function validateBundleSnapshot(
  snapshot: BundleSnapshot,
): BundleValidation {
  const issues: BundleIssue[] = [];
  const { app } = snapshot;
  if (app.architecture !== "arm64") {
    issue(
      issues,
      "APP_ARCHITECTURE",
      `Expected arm64, received ${app.architecture}`,
    );
  }
  if (app.bundleId !== "com.qali.desktop") {
    issue(
      issues,
      "APP_BUNDLE_ID",
      `Unexpected bundle identifier ${app.bundleId}`,
    );
  }
  if (app.category !== "public.app-category.productivity") {
    issue(
      issues,
      "APP_CATEGORY",
      `Unexpected application category ${app.category}`,
    );
  }
  if (app.allowsArbitraryLoads) {
    issue(
      issues,
      "APP_TRANSPORT_SECURITY",
      "Arbitrary network loads are enabled",
    );
  }
  if (app.name !== "Qali") {
    issue(issues, "APP_NAME", `Unexpected product name ${app.name}`);
  }
  if (app.version !== "0.1.0") {
    issue(issues, "APP_VERSION", `Unexpected product version ${app.version}`);
  }
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(app.minimumSystemVersion)) {
    issue(
      issues,
      "MINIMUM_SYSTEM_VERSION",
      "Minimum macOS version is absent or invalid",
    );
  }

  for (const path of snapshot.asarFiles) {
    if (/^\/node_modules\/@qali(?:\/|$)/.test(path)) {
      issue(
        issues,
        "ASAR_WORKSPACE_SOURCE",
        "Workspace source was externalized into the app",
        path,
      );
    }
    if (path.endsWith(".map")) {
      issue(issues, "ASAR_SOURCE_MAP", "Private source map is packaged", path);
    }
    if (
      /(?:^|\/)(?:test|tests|__tests__|fixtures|coverage|\.cache)(?:\/|\.|$)/i.test(
        path,
      ) ||
      /\.(?:test|itest|spec)\.[^/]+$/i.test(path)
    ) {
      issue(
        issues,
        "ASAR_TEST_SOURCE",
        "Test or cache source is packaged",
        path,
      );
    }
  }

  for (const executable of snapshot.executableFiles) {
    if (!executableAllowed(executable.path)) {
      issue(
        issues,
        "EXECUTABLE_ALLOWLIST",
        "Executable is not declared by the release policy",
        executable.path,
      );
    }
    if (
      executable.architectures.length !== 1 ||
      executable.architectures[0] !== "arm64"
    ) {
      issue(
        issues,
        "EXECUTABLE_ARCHITECTURE",
        "Executable is not arm64-only",
        executable.path,
      );
    }
    if ((executable.mode & 0o111) === 0) {
      issue(
        issues,
        "EXECUTABLE_MODE",
        "Executable bit is absent",
        executable.path,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(executable.sha256)) {
      issue(
        issues,
        "EXECUTABLE_HASH",
        "Executable SHA-256 is invalid",
        executable.path,
      );
    }
    if (!executable.signatureValid) {
      issue(
        issues,
        "EXECUTABLE_SIGNATURE",
        "Executable signature is invalid",
        executable.path,
      );
    }
    for (const library of executable.dynamicLibraries) {
      if (!dynamicLibraryAllowed(library)) {
        issue(
          issues,
          "DYNAMIC_LIBRARY_PATH",
          `Undeclared dynamic library ${library}`,
          executable.path,
        );
      }
    }
  }

  for (const file of snapshot.files) {
    if (file.path === "Contents/Resources/packaged-smoke-authority.json") {
      issue(
        issues,
        "SMOKE_AUTHORITY_IN_RELEASE",
        "Stable release contains disposable smoke authority",
        file.path,
      );
    }
    if (file.path === "Contents/Resources/packaged-smoke-build-identity.json") {
      issue(
        issues,
        "SMOKE_IDENTITY_IN_RELEASE",
        "Stable release contains disposable smoke build identity",
        file.path,
      );
    }
    if (file.escapesBundle) {
      issue(
        issues,
        "SYMLINK_ESCAPE",
        "Packaged symlink escapes the application bundle",
        file.path,
      );
    }
    if (file.symlink && file.path.startsWith("Contents/Resources/")) {
      issue(
        issues,
        "RESOURCE_SYMLINK",
        "Packaged Resources may not contain symlinks",
        file.path,
      );
    }
    if ((file.mode & 0o022) !== 0) {
      issue(
        issues,
        "RESOURCE_MODE",
        "Packaged resource is group/other writable",
        file.path,
      );
    }
    if (!file.symlink && (file.mode & 0o111) !== 0) {
      issue(
        issues,
        "NON_MACHO_EXECUTABLE",
        "Executable file is not declared Mach-O code",
        file.path,
      );
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      issue(issues, "RESOURCE_HASH", "Resource SHA-256 is invalid", file.path);
    }
  }

  issues.push(...snapshot.inventoryIssues);

  for (const match of snapshot.forbiddenMatches) {
    issue(
      issues,
      match.rule,
      "Forbidden package content was found",
      match.path,
    );
  }
  if (!snapshot.resourceManifestHashesAgree) {
    issue(
      issues,
      "RESOURCE_MANIFEST_HASH",
      "Packaged resource bytes disagree with their committed manifest",
    );
  }
  if (!snapshot.signatureValid) {
    issue(issues, "APP_SIGNATURE", "Application bundle signature is invalid");
  }
  return { issues };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalInventoryRoot(
  entries: readonly ExactInventoryEntry[],
): string {
  return sha256(
    Buffer.from(
      entries
        .map((entry) =>
          JSON.stringify({
            bytes: entry.bytes,
            kind: entry.kind,
            mode: entry.mode,
            path: entry.path,
            sha256: entry.sha256,
            ...(entry.unpacked === undefined
              ? {}
              : { unpacked: entry.unpacked }),
          }),
        )
        .join("\n"),
    ),
  );
}

async function fileProof(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

export async function collectDirectoryInventory(
  root: string,
  options: Readonly<{ exclude?: ReadonlySet<string> }> = {},
): Promise<ExactInventoryEntry[]> {
  const canonicalRoot = await realpath(root);
  const entries: ExactInventoryEntry[] = [];
  for (const entry of await walk(canonicalRoot)) {
    if (options.exclude?.has(entry.path)) continue;
    const metadata = await lstat(entry.absolute);
    if (metadata.isSymbolicLink()) {
      entries.push({
        bytes: Buffer.byteLength(await readlink(entry.absolute), "utf8"),
        kind: "link",
        mode: metadata.mode & 0o777,
        path: entry.path,
        sha256: null,
      });
    } else if (metadata.isDirectory()) {
      entries.push({
        bytes: 0,
        kind: "directory",
        mode: metadata.mode & 0o777,
        path: entry.path,
        sha256: null,
      });
    } else if (metadata.isFile()) {
      const bytes = await readFile(entry.absolute);
      entries.push({
        bytes: bytes.byteLength,
        kind: "file",
        mode: metadata.mode & 0o777,
        path: entry.path,
        sha256: sha256(bytes),
      });
    }
  }
  return entries;
}

export async function collectAsarInventory(
  asarPath: string,
): Promise<ExactInventoryEntry[]> {
  return listPackage(asarPath, { isPack: false })
    .sort()
    .map((path) => {
      const normalizedPath = path.replace(/^\//, "");
      const metadata = statFile(asarPath, normalizedPath, false);
      if ("files" in metadata) {
        return {
          bytes: 0,
          kind: "directory" as const,
          mode: 0o755,
          path,
          sha256: null,
          unpacked: metadata.unpacked === true,
        };
      }
      if ("link" in metadata) {
        return {
          bytes: Buffer.byteLength(metadata.link, "utf8"),
          kind: "link" as const,
          mode: 0o777,
          path,
          sha256: null,
          unpacked: metadata.unpacked === true,
        };
      }
      const bytes = extractFile(asarPath, normalizedPath, false);
      return {
        bytes: bytes.byteLength,
        kind: "file" as const,
        mode: metadata.executable ? 0o755 : 0o644,
        path,
        sha256: sha256(bytes),
        unpacked: metadata.unpacked === true,
      };
    });
}

export async function collectPackagingInputProofs(
  repositoryRoot: string,
  sourceProof?: ReleaseSourceProof,
): Promise<PackagingInputProofs> {
  const desktopOutput = await collectDirectoryInventory(
    resolve(repositoryRoot, "apps/desktop/out"),
  );
  const releaseInputs = await verifyReleaseInputAllowlist(repositoryRoot);
  return {
    builderConfig: await fileProof(
      resolve(repositoryRoot, "apps/desktop/electron-builder.yml"),
    ),
    dependencyLock: await fileProof(resolve(repositoryRoot, "bun.lock")),
    desktopOutput: {
      entries: desktopOutput.length,
      sha256: canonicalInventoryRoot(desktopOutput),
    },
    desktopPackage: await fileProof(
      resolve(repositoryRoot, "apps/desktop/package.json"),
    ),
    releaseInputs: {
      entries: releaseInputs.entries.length,
      manifest: await fileProof(
        resolve(repositoryRoot, "apps/desktop/release-input-allowlist.json"),
      ),
      sha256: sha256(
        Buffer.from(
          releaseInputs.entries
            .map((entry) => JSON.stringify(entry))
            .join("\n"),
        ),
      ),
    },
    source: sourceProof ?? (await collectReleaseSourceState(repositoryRoot)),
  };
}

function createCriticalResourceEntries(
  resourceEntries: readonly ExactInventoryEntry[],
): Array<{ bytes: number; mode: number; path: string; sha256: string }> {
  const byPath = new Map(resourceEntries.map((entry) => [entry.path, entry]));
  return [
    "app.asar.unpacked/node_modules/@esbuild/darwin-arm64/bin/esbuild",
    "bin/convex-generate-key",
    "bin/convex-local-backend",
    "bin/keychain-helper",
    "codex-calendar.sb",
    "codex-finalizer-output.schema.json",
    "codex-planner-output.schema.json",
    "codex-provider-manifest.json",
    "convex-cli/cli.bundle.cjs",
    "release-manifest.json",
  ].map((path) => {
    const entry = byPath.get(path);
    if (!entry || entry.kind !== "file" || entry.sha256 === null) {
      throw new Error(`Manifested resource is absent: ${path}`);
    }
    return { bytes: entry.bytes, mode: entry.mode, path, sha256: entry.sha256 };
  });
}

export async function createPackagedResourceManifest(
  appPath: string,
  repositoryRoot: string,
  sourceProof?: ReleaseSourceProof,
): Promise<PackagedResourceManifest> {
  const resources = resolve(appPath, "Contents/Resources");
  const asarEntries = await collectAsarInventory(
    resolve(resources, "app.asar"),
  );
  const resourceEntries = await collectDirectoryInventory(resources, {
    exclude: new Set(["packaged-resource-manifest.json"]),
  });
  return {
    asarEntries,
    entries: createCriticalResourceEntries(resourceEntries),
    formatVersion: 2,
    inputs: await collectPackagingInputProofs(repositoryRoot, sourceProof),
    resourceEntries,
  };
}

async function command(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

async function commandSucceeds(
  commandName: string,
  args: string[],
): Promise<boolean> {
  try {
    await command(commandName, args);
    return true;
  } catch {
    return false;
  }
}

async function inspectArchitectures(
  path: string,
  bytes: Uint8Array,
): Promise<string[]> {
  try {
    return parseLipoArchitectures(
      await command("/usr/bin/lipo", ["-info", path]),
    );
  } catch {
    const architectures = parseMachOArchitectures(bytes);
    if (architectures.length === 0) throw new Error(`MACH_O_ARCHITECTURE:${path}`);
    return architectures;
  }
}

async function inspectDynamicLibraries(
  path: string,
  bytes: Uint8Array,
): Promise<string[]> {
  try {
    return parseOtoolLibraries(
      await command("/usr/bin/otool", ["-m", "-L", path]),
    );
  } catch {
    return parseMachODynamicLibraries(bytes);
  }
}

async function codeSignatureIdentity(path: string): Promise<{
  identifier: string;
  signature: string;
  teamIdentifier: string;
}> {
  const result = await execFileAsync("/usr/bin/codesign", ["-dvv", path], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const source = `${result.stdout}\n${result.stderr}`;
  const field = (name: string): string =>
    source.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
  return {
    identifier: field("Identifier"),
    signature: field("Signature"),
    teamIdentifier: field("TeamIdentifier"),
  };
}

async function walk(
  root: string,
): Promise<Array<{ absolute: string; path: string }>> {
  const entries: Array<{ absolute: string; path: string }> = [];
  async function visit(directory: string): Promise<void> {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolute = resolve(directory, entry.name);
      entries.push({
        absolute,
        path: relative(root, absolute).split(sep).join("/"),
      });
      if (entry.isDirectory()) await visit(absolute);
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function isMachO(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const magic = Buffer.from(bytes).subarray(0, 4).toString("hex");
  return new Set([
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
  ]).has(magic);
}

export async function collectMachOPaths(appPath: string): Promise<string[]> {
  const root = await realpath(appPath);
  const paths: string[] = [];
  for (const entry of await walk(root)) {
    const metadata = await lstat(entry.absolute);
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      if (isMachO(await readFile(entry.absolute))) paths.push(entry.path);
    }
  }
  return paths.sort();
}

function textCandidate(path: string, bytes: Uint8Array): boolean {
  return (
    bytes.byteLength <= 16 * 1024 * 1024 &&
    /\.(?:c?js|mjs|json|html|css|svg|txt|md|sb|ts)$/i.test(path)
  );
}

type ReleaseManifest = {
  convex: {
    backend: { bytes: number; path: string; sha256: string };
    cli: { bytes: number; path: string; sha256: string };
    keygen: { bytes: number; path: string; sha256: string };
  };
};

async function validatePackagedManifest(
  resources: string,
  repositoryRoot: string,
  sourceProof?: ReleaseSourceProof,
): Promise<{ agrees: boolean; issues: BundleIssue[] }> {
  const issues: BundleIssue[] = [];
  const sourceManifest = JSON.parse(
    await readFile(resolve(resources, "release-manifest.json"), "utf8"),
  ) as ReleaseManifest;
  if (sourceManifest.convex.cli.path !== "convex-cli/cli.bundle.cjs") {
    issue(
      issues,
      "RESOURCE_MANIFEST_SOURCE",
      "Release manifest has an unexpected CLI path",
    );
  }
  const manifestSource = await readFile(
    resolve(resources, "packaged-resource-manifest.json"),
    "utf8",
  );
  const manifest = JSON.parse(manifestSource) as PackagedResourceManifest;
  if (manifest.formatVersion !== 2) {
    issue(
      issues,
      "RESOURCE_MANIFEST_VERSION",
      "Packaged resource manifest version is invalid",
    );
    return { agrees: false, issues };
  }
  if (manifestSource !== encodePackagedResourceManifest(manifest)) {
    issue(
      issues,
      "RESOURCE_MANIFEST_CANONICAL",
      "Packaged resource manifest is not canonical JSON",
      "packaged-resource-manifest.json",
    );
  }
  const actualResources = await collectDirectoryInventory(resources, {
    exclude: new Set(["packaged-resource-manifest.json"]),
  });
  const actualAsar = await collectAsarInventory(resolve(resources, "app.asar"));
  issues.push(
    ...compareExactInventory(
      "RESOURCE",
      manifest.resourceEntries,
      actualResources,
    ),
  );
  issues.push(
    ...compareExactInventory("ASAR", manifest.asarEntries, actualAsar),
  );
  const actualInputs = await collectPackagingInputProofs(
    repositoryRoot,
    sourceProof,
  );
  if (JSON.stringify(actualInputs) !== JSON.stringify(manifest.inputs)) {
    issue(
      issues,
      "PACKAGING_INPUTS",
      "Packaged allowlists are not bound to the current build outputs and package configuration",
    );
  }
  for (const entry of actualResources) {
    if (entry.kind === "link") {
      issue(
        issues,
        "RESOURCE_SYMLINK",
        "Packaged Resources may not contain symlinks",
        entry.path,
      );
    }
    if ((entry.mode & 0o022) !== 0) {
      issue(
        issues,
        "RESOURCE_MODE",
        "Packaged resource is group/other writable",
        entry.path,
      );
    }
  }
  const criticalByPath = new Map(
    manifest.entries.map((entry) => [entry.path, entry]),
  );
  const expectedCritical = createCriticalResourceEntries(actualResources);
  if (
    criticalByPath.size !== manifest.entries.length ||
    JSON.stringify(
      [...criticalByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    ) !==
      JSON.stringify(
        [...expectedCritical].sort((a, b) => a.path.localeCompare(b.path)),
      )
  ) {
    issue(
      issues,
      "RESOURCE_MANIFEST_CRITICAL",
      "Critical resource proofs are incomplete or changed",
    );
  }
  const codex = JSON.parse(
    await readFile(resolve(resources, "codex-provider-manifest.json"), "utf8"),
  ) as { sandbox: { path: string; sha256: string } };
  if (
    sha256(await readFile(resolve(resources, codex.sandbox.path))) !==
    codex.sandbox.sha256
  ) {
    issue(
      issues,
      "CODEX_SANDBOX_HASH",
      "Codex sandbox bytes disagree with the provider manifest",
    );
  }
  return { agrees: issues.length === 0, issues };
}

export async function inspectAppBundle(
  appPath: string,
  sourceProof?: ReleaseSourceProof,
): Promise<BundleSnapshot> {
  const appRoot = await realpath(appPath);
  const repositoryRoot = resolve(appRoot, "../..");
  const appMetadata = await lstat(appPath);
  if (!appMetadata.isDirectory() || appMetadata.isSymbolicLink()) {
    throw new Error("Qali.app must be a real directory");
  }
  const plist = JSON.parse(
    await command("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      resolve(appRoot, "Contents/Info.plist"),
    ]),
  ) as Record<string, unknown>;
  const executablePath = resolve(appRoot, "Contents/MacOS/Qali");
  const executableBytes = await readFile(executablePath);
  const appArchitectures = await inspectArchitectures(
    executablePath,
    executableBytes,
  );
  const asarPath = resolve(appRoot, "Contents/Resources/app.asar");
  const asarFiles = listPackage(asarPath, { isPack: false }).sort();
  // @electron/asar's extraction API mutates its in-process header cache while
  // reading link-backed entries. Validate the sealed inventory before the
  // independent forbidden-text scan so the inventory observes pristine bytes.
  const manifestValidation = await validatePackagedManifest(
    resolve(appRoot, "Contents/Resources"),
    repositoryRoot,
    sourceProof,
  ).catch((error: unknown) => ({
    agrees: false,
    issues: [
      {
        detail: `Packaged manifest could not be verified: ${String(error)}`,
        rule: "RESOURCE_MANIFEST_READ",
      },
    ],
  }));
  const forbiddenMatches: Array<{ path: string; rule: string }> = [];
  for (const path of asarFiles) {
    try {
      const bytes = extractFile(asarPath, path);
      if (textCandidate(path, bytes)) {
        forbiddenMatches.push(
          ...findForbiddenTextMatches(bytes, `app.asar${path}`),
        );
      }
    } catch {
      // Directory entries are inventory-only.
    }
  }

  const executableFiles: BundleSnapshot["executableFiles"][number][] = [];
  const files: BundleSnapshot["files"][number][] = [];
  for (const entry of await walk(appRoot)) {
    const metadata = await lstat(entry.absolute);
    if (metadata.isSymbolicLink()) {
      const target = await realpath(entry.absolute).catch(() => "");
      files.push({
        escapesBundle: !(
          target === appRoot || target.startsWith(`${appRoot}${sep}`)
        ),
        mode: metadata.mode,
        path: entry.path,
        sha256: "0".repeat(64),
        symlink: true,
      });
      continue;
    }
    if (!metadata.isFile()) continue;
    const bytes = await readFile(entry.absolute);
    const digest = sha256(bytes);
    if (isMachO(bytes)) {
      executableFiles.push({
        architectures: await inspectArchitectures(entry.absolute, bytes),
        bytes: bytes.byteLength,
        dynamicLibraries: await inspectDynamicLibraries(entry.absolute, bytes),
        mode: metadata.mode,
        path: entry.path,
        sha256: digest,
        signatureIdentity: await codeSignatureIdentity(entry.absolute),
        signatureValid: await commandSucceeds("/usr/bin/codesign", [
          "--verify",
          "--strict",
          entry.absolute,
        ]),
      });
    } else {
      files.push({
        mode: metadata.mode,
        path: entry.path,
        sha256: digest,
        symlink: false,
      });
      if (
        textCandidate(entry.path, bytes) &&
        entry.path !== "Contents/Resources/app.asar"
      ) {
        const matches = findForbiddenTextMatches(bytes, entry.path);
        forbiddenMatches.push(
          ...matches.filter(
            (match) =>
              entry.path !== "Contents/Resources/convex-cli/cli.bundle.cjs" ||
              match.rule !== "DEVELOPMENT_REFERENCE",
          ),
        );
      }
    }
  }

  const actualCode = new Set(executableFiles.map((entry) => entry.path));
  const expectedCode = new Set<string>(EXPECTED_MACH_O_PATHS);
  for (const path of expectedCode) {
    if (!actualCode.has(path)) {
      issue(
        manifestValidation.issues,
        "EXECUTABLE_INVENTORY_MISSING",
        "Expected Mach-O code is missing from the final artifact",
        path,
      );
    }
  }
  for (const path of actualCode) {
    if (!expectedCode.has(path)) {
      issue(
        manifestValidation.issues,
        "EXECUTABLE_INVENTORY_UNEXPECTED",
        "Unexpected Mach-O code is present in the final artifact",
        path,
      );
    }
  }

  return {
    app: {
      allowsArbitraryLoads:
        ((plist.NSAppTransportSecurity as Record<string, unknown> | undefined)
          ?.NSAllowsArbitraryLoads ?? false) === true,
      architecture: appArchitectures.join(" "),
      bundleId: String(plist.CFBundleIdentifier ?? ""),
      category: String(plist.LSApplicationCategoryType ?? ""),
      minimumSystemVersion: String(plist.LSMinimumSystemVersion ?? ""),
      name: String(plist.CFBundleName ?? ""),
      version: String(plist.CFBundleShortVersionString ?? ""),
    },
    asarFiles,
    executableFiles,
    files,
    forbiddenMatches,
    inventoryIssues: manifestValidation.issues,
    resourceManifestHashesAgree: manifestValidation.agrees,
    signatureValid: await commandSucceeds("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      appRoot,
    ]),
  };
}
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, opendir, readFile, readlink, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { extractFile, listPackage, statFile } from "@electron/asar";
import {
  collectReleaseSourceState,
  type ReleaseSourceProof,
  verifyReleaseInputAllowlist,
} from "./release-input-allowlist";

const execFileAsync = promisify(execFile);
