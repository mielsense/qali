import { lstat } from "node:fs/promises";

export class CodexBoundaryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexBoundaryError";
  }
}

const KEYRING_OVERRIDE = 'cli_auth_credentials_store="keyring"';
const CLOSED_FEATURES = [
  "apps", "auth_elicitation", "browser_use", "browser_use_external",
  "browser_use_full_cdp_access", "computer_use", "goals", "hooks",
  "image_generation", "in_app_browser", "multi_agent", "plugins",
  "shell_snapshot", "shell_tool", "skill_mcp_dependency_install", "skill_search",
  "tool_call_mcp_elicitation", "tool_suggest", "unified_exec", "view_image",
  "workspace_dependencies",
] as const;

export type CodexInvocation = Readonly<{
  command: "/opt/homebrew/bin/codex";
  args: string[];
  options: Readonly<{
    cwd: string;
    detached: true;
    env: Record<string, string>;
    shell: false;
    stdio: ["pipe", "pipe", "pipe"];
  }>;
}>;

export async function assertNoFileCredentials(
  codexHome: string,
  keyringHealthProbe?: () => Promise<boolean>,
): Promise<void> {
  try {
    await lstat(`${codexHome}/auth.json`);
    throw new CodexBoundaryError("CODEX_FILE_CREDENTIALS", "File credentials are forbidden");
  } catch (error) {
    if (error instanceof CodexBoundaryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CodexBoundaryError("CODEX_FILE_CREDENTIALS", "Credential-file state is untrusted");
    }
  }
  if (!keyringHealthProbe) {
    throw new CodexBoundaryError("CODEX_KEYRING_PROBE_REQUIRED", "A Keychain health probe is required");
  }
  if (!(await keyringHealthProbe())) {
    throw new CodexBoundaryError("CODEX_KEYRING_UNAVAILABLE", "The macOS Keychain backend is unavailable");
  }
}

export function buildCodexInvocation(input: {
  kind: "status" | "login" | "exec";
  codexHome: string;
  cwd: string;
  schemaPath?: string;
  proxyUrl?: string;
  testProvider?: { id: string; baseUrl: string; model: string };
}): CodexInvocation {
  const args = ["-c", KEYRING_OVERRIDE];
  if (input.testProvider) {
    const provider = input.testProvider;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(provider.baseUrl) || !/^[a-z0-9_-]+$/.test(provider.id)) {
      throw new CodexBoundaryError("CODEX_INVALID_TEST_PROVIDER", "Test provider must be explicit loopback");
    }
    args.push(
      "-c", `model_provider=${JSON.stringify(provider.id)}`,
      "-c", `model_providers.${provider.id}.name="Qali fixture"`,
      "-c", `model_providers.${provider.id}.base_url=${JSON.stringify(provider.baseUrl)}`,
      "-c", `model_providers.${provider.id}.wire_api="responses"`,
      "-c", `model_providers.${provider.id}.requires_openai_auth=false`,
      "-c", `model_providers.${provider.id}.request_max_retries=0`,
      "-c", `model_providers.${provider.id}.stream_max_retries=0`,
      "-c", `model=${JSON.stringify(provider.model)}`,
    );
  }
  args.push("-c", "agents.enabled=false", "-c", "allow_login_shell=false", "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false");
  for (const feature of CLOSED_FEATURES) args.push("--disable", feature);
  // Qali's deny-default sandbox-exec profile is the process boundary. Keeping
  // Codex's nested Seatbelt disabled avoids nested sandbox initialization while
  // the process driver structurally keeps this invocation behind that profile.
  if (input.kind === "exec") args.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
  if (input.kind === "status") args.push("login", "status");
  if (input.kind === "login") args.push("login", "--device-auth");
  if (input.kind === "exec") {
    if (!input.schemaPath) throw new CodexBoundaryError("CODEX_SCHEMA_REQUIRED", "A closed output schema is required");
    args.push(
      "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check",
      "--output-schema", input.schemaPath, "-",
    );
  }
  const env: Record<string, string> = {
    CODEX_HOME: input.codexHome,
    HOME: input.codexHome,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    PATH: "/usr/bin:/bin",
    TERM: "dumb",
    TMPDIR: input.codexHome,
    NO_PROXY: "127.0.0.1,localhost",
  };
  if (input.proxyUrl) {
    env.HTTPS_PROXY = input.proxyUrl;
    env.HTTP_PROXY = input.proxyUrl;
    env.ALL_PROXY = input.proxyUrl;
  }
  return {
    command: "/opt/homebrew/bin/codex",
    args,
    options: { cwd: input.cwd, detached: true, env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  };
}

export function buildLoginInvocation(input: Omit<Parameters<typeof buildCodexInvocation>[0], "kind">): CodexInvocation {
  return buildCodexInvocation({ ...input, kind: "login" });
}

export async function loginCodex(
  request: import("./process-driver").CodexLoginRequest,
  dependencies?: import("./process-driver").CodexDriverDependencies,
): Promise<import("./process-driver").CodexLoginResult> {
  const { runCodexLogin } = await import("./process-driver");
  return runCodexLogin(request, dependencies);
}
