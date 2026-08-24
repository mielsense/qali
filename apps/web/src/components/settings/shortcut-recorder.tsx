import type { Keybinding } from "@qali/desktop-contracts";
import { Button } from "@qali/ui/components/button";
import { Kbd, KbdGroup } from "@qali/ui/components/kbd";
import { useEffect, useState, type KeyboardEvent } from "react";

import {
  captureKeybinding,
  keybindingKeyLabels,
  normalizeKeybinding,
} from "@/commands/keybinding";

export function ShortcutRecorder({
  commandLabel,
  value,
  disabled = false,
  conflicts = [],
  onChange,
  onReset,
  onRecordingChange,
}: {
  commandLabel: string;
  value: Keybinding | null;
  disabled?: boolean;
  conflicts?: readonly string[];
  onChange(value: Keybinding | null): void;
  onReset?(): void;
  onRecordingChange?(recording: boolean): void;
}) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    onRecordingChange?.(recording);
  }, [onRecordingChange, recording]);

  const stopRecording = () => setRecording(false);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      onChange(null);
      stopRecording();
      return;
    }
    const binding = captureKeybinding(event.nativeEvent);
    if (!binding) return;
    onChange(binding);
    stopRecording();
  };

  const keyLabels = keybindingKeyLabels(value);
  const normalizedValue = value ? normalizeKeybinding(value) : null;
  const accessibleBinding = value
    ? `${normalizedValue?.modifiers
        .map((modifier) => {
          if (modifier === "meta") return "Command";
          if (modifier === "ctrl") return "Control";
          if (modifier === "alt") return "Option";
          return "Shift";
        })
        .join(" ")} ${keyLabels.at(-1)}`.trim()
    : "unassigned";

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button
        type="button"
        variant="raised"
        size="sm"
        disabled={disabled}
        data-keybinding-recorder
        data-recording={recording ? "true" : "false"}
        aria-pressed={recording}
        aria-invalid={conflicts.length > 0 || undefined}
        onClick={() => setRecording(true)}
        onBlur={stopRecording}
        onKeyDownCapture={onKeyDown}
        aria-label={
          recording
            ? `Recording ${commandLabel} keybinding`
            : `Change ${commandLabel} keybinding, currently ${accessibleBinding}`
        }
        className="min-w-24 rounded-lg px-2.5"
      >
        {recording ? (
          <span className="text-xs text-muted-foreground">Press keys…</span>
        ) : value ? (
          <KbdGroup aria-hidden="true">
            {keyLabels.map((label, index) => (
              <Kbd key={`${label}-${index}`}>{label}</Kbd>
            ))}
          </KbdGroup>
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        )}
      </Button>
      {onReset ? (
        <Button
          type="button"
          variant="quiet"
          size="sm"
          disabled={disabled}
          onClick={onReset}
          className="text-xs text-muted-foreground"
        >
          Reset
        </Button>
      ) : null}
      {conflicts.length > 0 ? (
        <span className="text-xs text-destructive" role="alert">
          Conflicts with {conflicts.join(", ")}
        </span>
      ) : null}
    </div>
  );
}
