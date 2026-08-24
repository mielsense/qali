import { ConfirmationDialog } from "@qali/ui/components/confirmation-dialog";

export function updateInstallCopy(version: string) {
  return {
    title: `Install Qali ${version} and restart?`,
    description:
      "Qali will finish its current calendar sync, close safely, install the verified update, and reopen. Unsaved event drafts will be interrupted.",
    confirmLabel: "Install and restart",
  } as const;
}

export function UpdateInstallDialog({
  installing,
  onConfirm,
  onOpenChange,
  open,
  version,
}: {
  installing: boolean;
  onConfirm(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  version: string;
}) {
  const copy = updateInstallCopy(version);

  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!installing) onOpenChange(nextOpen);
      }}
      title={copy.title}
      description={copy.description}
      eyebrow="Software update"
      confirmLabel={copy.confirmLabel}
      pendingLabel="Restarting…"
      pending={installing}
      onConfirm={onConfirm}
    />
  );
}
