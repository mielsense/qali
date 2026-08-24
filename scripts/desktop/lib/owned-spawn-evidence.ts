const KINDS = [
  "convex-backend",
  "convex-deploy-cli",
  "convex-keygen",
  "keychain-helper",
] as const;

type Kind = (typeof KINDS)[number];

const ENVIRONMENT_KEYS: Readonly<Record<Kind, ReadonlySet<string>>> = {
  "convex-backend": new Set(["LANG", "PATH"]),
  "convex-deploy-cli": new Set([
    "CI",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "CONVEX_SELF_HOSTED_URL",
    "ELECTRON_RUN_AS_NODE",
    "ESBUILD_BINARY_PATH",
    "LANG",
    "NODE_PATH",
    "PATH",
    "QALI_LOCAL_AUTH_CHANNEL",
  ]),
  "convex-keygen": new Set(["LANG", "PATH"]),
  "keychain-helper": new Set(["LANG", "PATH"]),
};

type Receipt = Readonly<{
  argv: readonly Readonly<{ classification: string; index: number; sha256: string }>[];
  environment: readonly Readonly<{ classification: string; key: string; sha256: string }>[];
  executable: Readonly<{ bytes: number; mode: number; path: string; sha256: string }>;
  instanceSecretOccurrences: Readonly<{
    argv: number;
    environment: number;
    executable: number;
  }>;
  kind: Kind;
}>;

export function parseCompleteSmokeMarker(
  source: string,
): Record<string, unknown> | null {
  try {
    const value = JSON.parse(source) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseReceipts(value: unknown): Receipt[] {
  if (!Array.isArray(value)) throw new Error("PACKAGED_SMOKE_OWNED_SPAWN_INVALID");
  const receipts = value as Receipt[];
  for (const receipt of receipts) {
    if (
      !receipt ||
      !KINDS.includes(receipt.kind) ||
      !Array.isArray(receipt.argv) ||
      !Array.isArray(receipt.environment) ||
      !receipt.executable ||
      !Number.isSafeInteger(receipt.executable.bytes) ||
      receipt.executable.bytes < 1 ||
      !Number.isSafeInteger(receipt.executable.mode) ||
      typeof receipt.executable.path !== "string" ||
      !validHash(receipt.executable.sha256) ||
      !receipt.instanceSecretOccurrences
    ) throw new Error("PACKAGED_SMOKE_OWNED_SPAWN_INVALID");
    receipt.argv.forEach((argument, index) => {
      if (
        argument.index !== index ||
        typeof argument.classification !== "string" ||
        !validHash(argument.sha256)
      ) throw new Error("PACKAGED_SMOKE_OWNED_SPAWN_INVALID");
    });
    let previousKey = "";
    for (const environment of receipt.environment) {
      if (
        typeof environment.classification !== "string" ||
        typeof environment.key !== "string" ||
        environment.key <= previousKey ||
        !ENVIRONMENT_KEYS[receipt.kind].has(environment.key) ||
        !validHash(environment.sha256)
      ) throw new Error("PACKAGED_SMOKE_OWNED_SPAWN_INVALID");
      previousKey = environment.key;
    }
  }
  return receipts;
}

export function assertOwnedSpawnEvidence(options: Readonly<{
  expectedExecutableSha256: Readonly<Partial<Record<Kind, string>>>;
  instanceSecretSha256: string;
  receipts: unknown;
}>): Receipt[] {
  if (!validHash(options.instanceSecretSha256)) {
    throw new Error("PACKAGED_SMOKE_OWNED_SPAWN_INVALID");
  }
  const receipts = parseReceipts(options.receipts);
  for (const receipt of receipts) {
    const expectedExecutable = options.expectedExecutableSha256[receipt.kind];
    if (!expectedExecutable || receipt.executable.sha256 !== expectedExecutable) {
      throw new Error("PACKAGED_SMOKE_OWNED_EXECUTABLE_MISMATCH");
    }
    const secretFingerprints = [
      ...receipt.argv.map(({ sha256 }) => sha256),
      ...receipt.environment.map(({ sha256 }) => sha256),
    ].filter((fingerprint) => fingerprint === options.instanceSecretSha256).length;
    const occurrences = receipt.instanceSecretOccurrences;
    if (receipt.kind === "convex-backend") {
      if (
        secretFingerprints !== 1 ||
        occurrences.argv !== 1 ||
        occurrences.environment !== 0 ||
        occurrences.executable !== 0 ||
        receipt.argv.filter(({ classification }) =>
          classification === "convex-instance-secret"
        ).length !== 1
      ) throw new Error("PACKAGED_SMOKE_OWNED_SPAWN_SECRET_LEAK");
    } else if (
      secretFingerprints !== 0 ||
      occurrences.argv !== 0 ||
      occurrences.environment !== 0 ||
      occurrences.executable !== 0
    ) {
      throw new Error("PACKAGED_SMOKE_OWNED_SPAWN_SECRET_LEAK");
    }
  }
  return receipts;
}
