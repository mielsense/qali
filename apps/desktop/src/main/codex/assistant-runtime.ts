import type { AssistantProviderStatus } from "@qali/desktop-contracts";

import { loginCodex } from "./auth";
import type { CodexRuntimeAuthority } from "./boundary";
import { cancelCodexAttempt } from "./process-driver";

export type AssistantLoginRuntime = Readonly<{
  cancel(attemptId: string): boolean;
  login(attemptId: string, signal: AbortSignal): Promise<void>;
  status(): Promise<AssistantProviderStatus>;
}>;

/** Runtime-facing login controller. Possessing the branded authority is the
 * only way this controller can exist; blocked builds pass no authority and
 * therefore cannot reach the process driver. */
export function createCodexAssistantRuntime(
  authority: CodexRuntimeAuthority,
  publishStatus: (attemptId: string, status: AssistantProviderStatus) => void,
): AssistantLoginRuntime {
  let status: AssistantProviderStatus = { kind: "authentication-required" };
  return Object.freeze({
    status: async () => status,
    cancel: (attemptId) => cancelCodexAttempt(attemptId),
    async login(attemptId, signal) {
      try {
        await loginCodex({ authority, attemptId, signal, timeoutMs: 300_000 });
        status = { kind: "ready" };
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "";
        status =
          code === "CODEX_CANCELLED"
            ? { kind: "authentication-required" }
            : code.includes("BINARY") || code.includes("CAPABILITY")
              ? { kind: "incompatible" }
              : code.includes("TIMEOUT") || code.includes("PROCESS")
                ? { kind: "offline" }
                : { kind: "unavailable" };
      }
      publishStatus(attemptId, status);
    },
  });
}
