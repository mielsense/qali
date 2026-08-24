import { Button } from "@qali/ui/components/button";
import { MotionDialog } from "@qali/ui/components/motion-dialog";

export function ConfirmationDialog({
  cancelLabel = "Cancel",
  confirmLabel,
  confirmTone = "default",
  description,
  eyebrow,
  onConfirm,
  onOpenChange,
  open,
  pending = false,
  pendingLabel,
  title,
}: {
  cancelLabel?: string;
  confirmLabel: string;
  confirmTone?: "default" | "destructive";
  description: string;
  eyebrow?: string;
  onConfirm(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  pending?: boolean;
  pendingLabel?: string;
  title: string;
}) {
  return (
    <MotionDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!pending) onOpenChange(nextOpen);
      }}
      label={title}
      className="max-w-[500px]"
    >
      <div className="px-5 pb-5 pt-5">
        {eyebrow ? (
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="mt-2 text-[15px] font-semibold leading-5 text-foreground [text-wrap:balance]">
          {title}
        </h2>
        <p className="mt-2 max-w-[54ch] text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
          {description}
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--qali-edge-subtle)] bg-[var(--qali-surface-flat)] px-4 py-3">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={confirmTone}
          size="sm"
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
        </Button>
      </div>
    </MotionDialog>
  );
}
