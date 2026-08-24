// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("workspace floating materials", () => {
  test("uses a flat Motion right drawer with a dedicated glass composer", () => {
    const dock = read("./assistant-dock.tsx");
    const shell = read("./assistant-shell.tsx");
    const composer = read("./assistant-composer.tsx");

    expect(dock).toContain("AnimatePresence");
    expect(dock).toContain("motion.aside");
    expect(dock).toContain("useReducedMotion");
    expect(dock).toContain("animate={{ width: 560, opacity: 1 }}");
    expect(dock).toContain("max-w-[40vw]");
    expect(dock).toContain("shrink-0");
    expect(dock).toContain("border-s border-border bg-background");
    expect(dock).not.toContain("goo-panel-theme");
    expect(dock).not.toContain("GooDropdown");
    expect(dock).toContain("session.refreshStatus()");
    expect(shell).toContain('from "@qali/ui/components/button"');
    expect(shell).toContain("bg-background p-4");
    expect(shell).not.toContain("GlassSurface");
    expect(shell).not.toContain("rounded-l-[24px]");
    expect(shell).not.toContain("shadow-[var(--qali-shadow-float)]");
    expect(shell).toContain('variant="quiet"');
    expect(shell).toContain('size="icon-sm"');
    expect(shell).not.toContain("bg-popover/82");
    expect(composer).toContain('variant="composer"');
    expect(composer).toContain('from "@qali/ui/components/button"');
    expect(composer).toContain('variant="accent"');
    expect(composer).toContain('size="icon-xs"');
    expect(composer).not.toContain("flex size-10 shrink-0");
    expect(composer).not.toContain("bg-popover/80");
  });

  test("keeps the assistant separate from the opaque goo navigation dock", () => {
    const dock = read("./bottom-island.tsx");
    const cluster = read("./floating-action-cluster.tsx");

    expect(dock).toContain("qali-goo-surface");
    expect(dock).not.toContain("qali-glass qali-glass--dock");
    expect(dock).not.toContain("playHoverSound");
    expect(dock).not.toContain("playClickSound()");
    expect(dock).toContain("Contextual event surface");
    expect(dock).not.toContain("<AssistantDock />");
    expect(cluster).not.toContain('from "./assistant-dock"');
    expect(cluster).not.toContain("data-floating-assistant-launcher");
    const layout = read("./workspace-layout.tsx");
    expect(layout).toContain("<AssistantDock />");
  });

  test("keeps settings on the same opaque canvas as the calendar", () => {
    const layout = read("../settings/settings-layout.tsx");
    const sidebar = read("../settings/settings-sidebar.tsx");

    expect(layout).toContain("bg-background");
    expect(sidebar).toContain("bg-background");
    expect(sidebar).not.toContain("bg-card");
  });

  test("uses the calendar canvas color for structural header and rail", () => {
    const chrome = read("./workspace-chrome.tsx");
    const styles = read("../../../../../packages/ui/src/styles/globals.css");

    expect(chrome).toContain("bg-background");
    expect(chrome).not.toContain('variant="shell"');
    expect(styles).toContain(".qali-shell-linework::after");
    expect(styles).toContain("top: 0;");
  });
});
