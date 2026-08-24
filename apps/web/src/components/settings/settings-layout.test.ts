// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("settings workspace layout", () => {
  test("continues the settings navigation through the workspace header", () => {
    const layout = read("./settings-layout.tsx");

    expect(layout).toContain("settings-sidebar-header");
    expect(layout).toContain("border-e border-border");
    expect(layout).not.toContain("calendar-window-header flex h-[52px]");
  });

  test("centers the active settings page in the remaining canvas", () => {
    const layout = read("./settings-layout.tsx");

    expect(layout).toContain("justify-center overflow-y-auto");
    expect(layout).toContain("max-w-[900px]");
  });

  test("uses one flat navigation edge without a top frame", () => {
    const sidebar = read("./settings-sidebar.tsx");
    const section = read("./settings-section.tsx");

    expect(sidebar).toContain("border-e border-border");
    expect(sidebar).not.toContain("border-[var(--qali-glass-edge)]");
    expect(sidebar).not.toContain("qali-elevation-attached");
    expect(sidebar).toContain("min-h-0");
    expect(sidebar).toContain("overflow-y-auto");
    expect(sidebar).toContain("focusedIndex >= 0 ? focusedIndex : routeIndex");
    expect(sidebar).toContain('active && "font-medium text-[var(--qali-accent)]"');
    expect(sidebar).not.toContain("border-border bg-muted font-medium");
    expect(section).not.toContain("border-y");
  });
});
