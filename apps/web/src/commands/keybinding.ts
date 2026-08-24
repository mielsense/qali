import type {
  CommandId,
  Keybinding,
  KeybindingModifier,
} from "@qali/desktop-contracts";

import {
  COMMANDS,
  COMMAND_BY_ID,
  effectiveKeybinding,
  type CommandDefinition,
  type KeybindingOverrides,
} from "./registry";

export interface KeyEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  metaKey: boolean;
  repeat?: boolean;
  shiftKey: boolean;
  target?: EventTarget | null;
}

export interface CommandResolutionContext {
  calendar: boolean;
  recording?: boolean;
  menuOpen?: boolean;
  dialogOpen?: boolean;
}

const MODIFIER_ORDER: readonly KeybindingModifier[] = [
  "meta",
  "ctrl",
  "alt",
  "shift",
];

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  spacebar: " ",
};

const MODIFIER_KEYS = new Set(["alt", "altgraph", "control", "meta", "shift"]);

export function normalizeKeybinding(binding: Keybinding): Keybinding {
  const lowerKey = binding.key.toLowerCase();
  const key = KEY_ALIASES[lowerKey] ?? lowerKey;
  const modifiers = MODIFIER_ORDER.filter((modifier) =>
    binding.modifiers.includes(modifier),
  );
  return { key, modifiers };
}

export function captureKeybinding(event: KeyEventLike): Keybinding | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const key = KEY_ALIASES[event.key.toLowerCase()] ?? event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key) || key === "process" || key === "dead")
    return null;
  const modifiers: KeybindingModifier[] = [];
  if (event.metaKey) modifiers.push("meta");
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  return normalizeKeybinding({ key, modifiers });
}

function closest(
  target: EventTarget | null | undefined,
  selector: string,
): boolean {
  if (!target || typeof target !== "object" || !("closest" in target))
    return false;
  const candidate = target as { closest(selector: string): unknown };
  return candidate.closest(selector) !== null;
}

function eventOwnerBlocksBareKey(
  target: EventTarget | null | undefined,
): boolean {
  return closest(
    target,
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='menu'], [role='dialog'], [aria-modal='true'], [data-keybinding-recorder]",
  );
}

function matches(event: KeyEventLike, binding: Keybinding): boolean {
  const normalized = normalizeKeybinding(binding);
  const captured = captureKeybinding(event);
  if (!captured || captured.key !== normalized.key) return false;
  return (
    captured.modifiers.length === normalized.modifiers.length &&
    captured.modifiers.every(
      (modifier, index) => modifier === normalized.modifiers[index],
    )
  );
}

export function resolveCommand(
  event: KeyEventLike,
  context: CommandResolutionContext,
  overrides: KeybindingOverrides = {},
): CommandId | null {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.keyCode === 229 ||
    context.recording
  ) {
    return null;
  }

  for (const definition of COMMANDS) {
    if (definition.context === "calendar" && !context.calendar) continue;
    const binding = effectiveKeybinding(definition.id, overrides);
    if (!binding || !matches(event, binding)) continue;
    const normalized = normalizeKeybinding(binding);
    const bareSingleLetter =
      normalized.key.length === 1 && normalized.modifiers.length === 0;
    if (
      bareSingleLetter &&
      (!context.calendar ||
        context.menuOpen ||
        context.dialogOpen ||
        eventOwnerBlocksBareKey(event.target))
    ) {
      return null;
    }
    return definition.id;
  }
  return null;
}

export function keybindingsEqual(
  left: Keybinding | null,
  right: Keybinding | null,
): boolean {
  if (left === null || right === null) return left === right;
  const a = normalizeKeybinding(left);
  const b = normalizeKeybinding(right);
  return (
    a.key === b.key &&
    a.modifiers.length === b.modifiers.length &&
    a.modifiers.every((modifier, index) => modifier === b.modifiers[index])
  );
}

function contextsOverlap(left: CommandId, right: CommandId): boolean {
  const a = COMMAND_BY_ID[left].context;
  const b = COMMAND_BY_ID[right].context;
  return a === b || a === "global" || b === "global";
}

export function findKeybindingConflicts(
  commandId: CommandId,
  binding: Keybinding,
  overrides: KeybindingOverrides,
): CommandId[] {
  return COMMANDS.filter(
    (candidate) =>
      candidate.id !== commandId &&
      contextsOverlap(commandId, candidate.id) &&
      effectiveKeybinding(candidate.id, overrides) !== null &&
      keybindingsEqual(
        binding,
        effectiveKeybinding(candidate.id, overrides) as Keybinding,
      ),
  ).map((candidate) => candidate.id);
}

export function setKeybindingOverride(
  overrides: KeybindingOverrides,
  commandId: CommandId,
  binding: Keybinding | null,
): KeybindingOverrides {
  return { ...overrides, [commandId]: binding && normalizeKeybinding(binding) };
}

export function resetKeybindingOverride(
  overrides: KeybindingOverrides,
  commandId: CommandId,
): KeybindingOverrides {
  const next = { ...overrides };
  delete next[commandId];
  return next;
}

export function clearKeybindingOverrides(
  _overrides: KeybindingOverrides,
): KeybindingOverrides {
  return {};
}

function keyLabel(key: string): string {
  const labels: Readonly<Record<string, string>> = {
    " ": "Space",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
    backspace: "⌫",
    delete: "⌦",
    enter: "↩",
    escape: "Esc",
    tab: "⇥",
  };
  return labels[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

const MODIFIER_SYMBOLS: Readonly<Record<KeybindingModifier, string>> = {
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};

const MODIFIER_SEARCH_TERMS: Readonly<
  Record<KeybindingModifier, readonly string[]>
> = {
  meta: ["meta", "command", "cmd", "⌘"],
  ctrl: ["control", "ctrl", "⌃"],
  alt: ["option", "alt", "⌥"],
  shift: ["shift", "⇧"],
};

export function keybindingKeyLabels(binding: Keybinding | null): string[] {
  if (!binding) return [];
  const normalized = normalizeKeybinding(binding);
  return [
    ...normalized.modifiers.map((modifier) => MODIFIER_SYMBOLS[modifier]),
    keyLabel(normalized.key),
  ];
}

function normalizeKeybindingSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll("⌘", " command ")
    .replaceAll("⌃", " control ")
    .replaceAll("⌥", " option ")
    .replaceAll("⇧", " shift ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function matchesKeybindingSearch(
  command: Pick<CommandDefinition, "context" | "id" | "label">,
  binding: Keybinding | null,
  query: string,
): boolean {
  const normalizedQuery = normalizeKeybindingSearchText(query);
  if (!normalizedQuery) return true;
  const normalizedBinding = binding ? normalizeKeybinding(binding) : null;
  const bindingTerms = normalizedBinding
    ? [
        ...normalizedBinding.modifiers.flatMap(
          (modifier) => MODIFIER_SEARCH_TERMS[modifier],
        ),
        normalizedBinding.key,
        keyLabel(normalizedBinding.key),
        formatKeybindingLabel(normalizedBinding),
      ]
    : ["disabled", "unassigned"];
  const haystack = normalizeKeybindingSearchText(
    `${command.label} ${command.id} ${command.context} ${bindingTerms.join(" ")}`,
  );
  return normalizedQuery.split(" ").every((token) => haystack.includes(token));
}

export function keybindingSearchQueryFromEvent(
  event: KeyEventLike,
): string | null {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const binding = captureKeybinding(event);
  return binding ? formatKeybindingLabel(binding) : null;
}

export function formatKeybindingLabel(binding: Keybinding | null): string {
  if (!binding) return "Disabled";
  const normalized = normalizeKeybinding(binding);
  return keybindingKeyLabels(normalized).join("");
}
