import { createFileRoute } from "@tanstack/react-router";

import { SettingsSection } from "@/components/settings/settings-section";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { useDesktopStatus } from "@/lib/desktop/status";

export const Route = createFileRoute("/_workspace/settings/assistant")({
  component: AssistantSettingsPage,
});

function AssistantSettingsPage() {
  const desktop = useDesktopStatus();
  const status = desktop?.assistant;
  const details = status
    ? assistantDetails(status.kind)
    : {
        title: "Desktop assistant unavailable",
        description:
          "The installed Codex assistant is available only in Qali for macOS.",
      };

  return (
    <SettingsSection
      title="Assistant"
      description="Qali uses an installed, authenticated Codex runtime without storing your credentials."
    >
      <SettingsGroup
        title="Codex provider"
        description="The assistant runs through the Codex installation already authenticated on this Mac."
      >
        <SettingsRow label="Provider status" description={details.description}>
          <span className="rounded-lg bg-background/70 px-2.5 py-1.5 text-xs font-medium text-foreground ring-1 ring-inset ring-[var(--qali-edge-subtle)]">
            {details.title}
          </span>
        </SettingsRow>
        <p className="px-3 pb-3 text-xs leading-5 text-muted-foreground">
          Qali verifies the installed version and sign-in state without receiving
          or storing your Codex credential.
        </p>
      </SettingsGroup>
    </SettingsSection>
  );
}

function assistantDetails(
  kind: NonNullable<ReturnType<typeof useDesktopStatus>>["assistant"]["kind"],
) {
  const descriptions = {
    probing: [
      "Checking Codex",
      "Qali is checking the installed Codex runtime.",
    ],
    ready: ["Ready", "Codex is installed, compatible, and ready to assist."],
    "ready-degraded": [
      "Ready with limits",
      "Codex is available with a reduced capability.",
    ],
    "authentication-required": [
      "Sign-in required",
      "Finish the Codex sign-in flow before sending an assistant request.",
    ],
    "needs-reprobe": [
      "Check again",
      "The installed Codex runtime needs to be checked again.",
    ],
    incompatible: [
      "Incompatible",
      "This installed Codex version is not supported by Qali yet.",
    ],
    unavailable: [
      "Unavailable",
      "No supported installed Codex runtime is available.",
    ],
    "probe-failed": [
      "Check failed",
      "Qali could not verify the installed Codex runtime.",
    ],
    offline: ["Offline", "The retired desktop runtime is offline."],
  } as const;
  const [title, description] = descriptions[kind];
  return { title, description };
}
