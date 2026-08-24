import {
  Alert02Icon,
  InformationCircleIcon,
  Login02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AssistantProviderStatus } from "@qali/desktop-contracts";

export type AssistantRemediation = "sign-in" | "reprobe" | "choose-installation" | "retry" | null;

export function assistantCanSend(
  status: AssistantProviderStatus | null | undefined,
): boolean {
  return status?.kind === "ready" || status?.kind === "ready-degraded";
}

export function assistantRemediation(status: AssistantProviderStatus | null | undefined): AssistantRemediation {
  switch (status?.kind) {
    case "authentication-required": return "sign-in";
    case "needs-reprobe": return "reprobe";
    case "incompatible": return "choose-installation";
    case "probe-failed":
    case "unavailable":
    case "offline": return "retry";
    default: return null;
  }
}

export function AssistantReadiness({
  status,
  onRemediate,
}: {
  status: AssistantProviderStatus | null | undefined;
  onRemediate: (action: AssistantRemediation) => void;
}) {
  if (!status || status.kind === "ready") return null;
  const remediation = assistantRemediation(status);
  const content = readinessContent(status.kind);
  const Icon = status.kind === "probing" || status.kind === "ready-degraded" ? InformationCircleIcon : Alert02Icon;
  return (
    <section role={status.kind === "probing" ? "status" : "alert"} className="flex items-start gap-2 rounded-xl border border-border/70 bg-muted/55 px-3 py-2.5 text-xs leading-4 text-muted-foreground">
      <HugeiconsIcon icon={Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{content.title}</p>
        <p className="mt-0.5">{content.description}</p>
      </div>
      {remediation && (
        <button type="button" onClick={() => onRemediate(remediation)} className="-my-1 shrink-0 rounded-md px-1.5 py-1 font-medium text-foreground outline-none hover:bg-background/75 focus-visible:ring-2 focus-visible:ring-ring">
          <HugeiconsIcon icon={remediation === "sign-in" ? Login02Icon : RefreshIcon} strokeWidth={2} className="mr-1 inline size-3.5" aria-hidden />
          {remediation === "sign-in" ? "Sign in" : remediation === "choose-installation" ? "Choose Codex" : remediation === "reprobe" ? "Check again" : "Retry"}
        </button>
      )}
    </section>
  );
}

function readinessContent(kind: AssistantProviderStatus["kind"]) {
  switch (kind) {
    case "probing": return { title: "Checking Codex", description: "Your draft is safe while Qali verifies this installation." };
    case "authentication-required": return { title: "Sign in to Codex", description: "Use your existing Codex account to continue." };
    case "needs-reprobe": return { title: "Codex changed", description: "Check the installation again before starting a new request." };
    case "incompatible": return { title: "Unsupported Codex version", description: "Choose a supported Codex installation to continue." };
    case "unavailable": return { title: "Assistant unavailable", description: "This build cannot start Codex right now. Try again after it is available." };
    case "probe-failed": return { title: "Couldn’t verify Codex", description: "Check the installation again. Your calendar and draft were not changed." };
    case "offline": return { title: "Assistant offline", description: "Reconnect, then try again. Your draft remains here." };
    case "ready-degraded": return { title: "Codex is limited", description: "Some assistant capabilities may be unavailable." };
    case "ready": return { title: "", description: "" };
  }
}
