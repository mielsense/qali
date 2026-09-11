import type { QaliSettingsDocument } from "@qali/desktop-contracts";

// Portal's Catppuccin accents, paired for light and dark appearance.
export const PRIMARY_COLORS = [
  { value: "mauve", label: "Mauve", light: "#8839ef", dark: "#cba6f7" },
  { value: "blue", label: "Blue", light: "#1e66f5", dark: "#89b4fa" },
  { value: "teal", label: "Teal", light: "#179299", dark: "#94e2d5" },
  { value: "green", label: "Green", light: "#40a02b", dark: "#a6e3a1" },
  { value: "peach", label: "Peach", light: "#fe640b", dark: "#fab387" },
  { value: "pink", label: "Pink", light: "#ea76cb", dark: "#f5c2e7" },
  { value: "red", label: "Red", light: "#d20f39", dark: "#f38ba8" },
  { value: "lavender", label: "Lavender", light: "#7287fd", dark: "#b4befe" },
] as const satisfies ReadonlyArray<{
  value: QaliSettingsDocument["appearance"]["primaryColor"];
  label: string;
  light: string;
  dark: string;
}>;

export function primaryColorValue(value: string, theme: "light" | "dark") {
  return (PRIMARY_COLORS.find((color) => color.value === value) ??
    PRIMARY_COLORS[0])[theme];
}
