import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";

export type OwnedSpawnKind =
  | "convex-backend"
  | "convex-deploy-cli"
  | "convex-keygen"
  | "keychain-helper";

type RawObservation = Readonly<{
  args: readonly string[];
  command: string;
  environment: Readonly<Record<string, string | undefined>>;
  kind: OwnedSpawnKind;
}>;

export type OwnedSpawnReceipt = Readonly<{
  argv: readonly Readonly<{
    classification: string;
    index: number;
    sha256: string;
  }>[];
  environment: readonly Readonly<{
    classification: string;
    key: string;
    sha256: string;
  }>[];
  executable: Readonly<{
    bytes: number;
    mode: number;
    path: string;
    sha256: string;
  }>;
  instanceSecretOccurrences: Readonly<{
    argv: number;
    environment: number;
    executable: number;
  }>;
  kind: OwnedSpawnKind;
}>;

let observations: RawObservation[] | null = null;
let instanceSecret: string | null = null;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function occurrences(value: string, needle: string): number {
  if (!needle || !value) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function classifyArgument(value: string, secret: string): string {
  if (value === secret) return "convex-instance-secret";
  if (/^--[a-z0-9-]+$/.test(value)) return "flag";
  if (/^(?:127\.0\.0\.1|https?:\/\/127\.0\.0\.1(?::\d+)?)$/.test(value)) {
    return "loopback";
  }
  if (/^\d+$/.test(value)) return "integer";
  if (value.includes("/") || value.endsWith(".sqlite3")) return "path";
  return "literal";
}

function classifyEnvironment(key: string): string {
  if (/KEY|SECRET|TOKEN|CREDENTIAL/i.test(key)) return "sensitive";
  if (key.endsWith("_PATH") || key === "PATH" || key === "NODE_PATH") return "path";
  if (key.endsWith("_URL")) return "loopback-url";
  return "configuration";
}

export function beginOwnedSpawnObservation(): void {
  observations = [];
  instanceSecret = null;
}

export function registerOwnedInstanceSecret(value: string): void {
  if (observations === null) return;
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("OWNED_SPAWN_INSTANCE_SECRET_INVALID");
  }
  if (instanceSecret !== null && instanceSecret !== value) {
    throw new Error("OWNED_SPAWN_INSTANCE_SECRET_CHANGED");
  }
  instanceSecret = value;
}

export function observeOwnedSpawn(
  kind: OwnedSpawnKind,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (observations === null) return;
  observations.push({
    args: [...args],
    command,
    environment: { ...environment },
    kind,
  });
}

export function finishOwnedSpawnObservation(): OwnedSpawnReceipt[] {
  const captured = observations;
  const secret = instanceSecret;
  observations = null;
  instanceSecret = null;
  if (captured === null || secret === null) {
    throw new Error("OWNED_SPAWN_OBSERVATION_INCOMPLETE");
  }
  return captured.map((observation) => {
    const command = realpathSync(observation.command);
    const metadata = lstatSync(command);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("OWNED_SPAWN_EXECUTABLE_INVALID");
    }
    const commandBytes = readFileSync(command);
    const argvOccurrences = observation.args.reduce(
      (total, value) => total + occurrences(value, secret),
      0,
    );
    const environmentOccurrences = Object.values(observation.environment).reduce(
      (total, value) => total + occurrences(value ?? "", secret),
      0,
    );
    const executableOccurrences = occurrences(command, secret);
    if (
      (observation.kind === "convex-backend" &&
        (argvOccurrences !== 1 || environmentOccurrences !== 0 || executableOccurrences !== 0)) ||
      (observation.kind !== "convex-backend" &&
        (argvOccurrences !== 0 || environmentOccurrences !== 0 || executableOccurrences !== 0))
    ) {
      throw new Error("OWNED_SPAWN_INSTANCE_SECRET_BOUNDARY_VIOLATION");
    }
    return {
      argv: observation.args.map((value, index) => ({
        classification: classifyArgument(value, secret),
        index,
        sha256: sha256(value),
      })),
      environment: Object.entries(observation.environment)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({
          classification: classifyEnvironment(key),
          key,
          sha256: sha256(value),
        })),
      executable: {
        bytes: commandBytes.byteLength,
        mode: metadata.mode & 0o777,
        path: command,
        sha256: sha256(commandBytes),
      },
      instanceSecretOccurrences: {
        argv: argvOccurrences,
        environment: environmentOccurrences,
        executable: executableOccurrences,
      },
      kind: observation.kind,
    };
  });
}
