// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
// @ts-expect-error Bun's test runtime supplies Node built-ins; the UI package's
// production TypeScript config intentionally includes browser globals only.
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const productAccent = ["#b2", "4b3d"].join("");
const components = [
  "button.tsx",
  "popover.tsx",
  "dropdown-menu.tsx",
  "tooltip.tsx",
  "ui/goo-dropdown.tsx",
].map((path) =>
  readFileSync(new URL(`../components/${path}`, import.meta.url), "utf8"),
);

describe("Qali typography", () => {
  test("uses the native macOS SF Pro system stack for interface text", () => {
    expect(source.replace(/\s+/g, " ")).toContain(
      '--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;',
    );
    expect(source).not.toContain('@import "@fontsource-variable/lexend"');
    expect(source).toContain("-webkit-font-smoothing: antialiased");
  });

  test("uses Geist Pixel Square as the restrained display highlight", () => {
    expect(source).toContain('font-family: "Geist Pixel Square"');
    expect(source).toContain(
      'url("../assets/fonts/geist/GeistPixel-Square.woff2")',
    );
    expect(source.replace(/\s+/g, " ")).toContain(
      '--font-display: "Geist Pixel Square", "Geist Mono",',
    );
    expect(source).toContain("--font-display--font-weight: 500;");
    expect(source).not.toContain("Fraunces");
  });
});

describe("Qali glass and elevation system", () => {
  test("defines the product accent exactly once and derives its roles", () => {
    expect(source.match(new RegExp(productAccent, "gi"))).toHaveLength(1);
    expect(source).toContain(`--qali-accent: ${productAccent};`);
    expect(source).toContain("--qali-accent-hover: color-mix(");
    expect(source).toContain("--qali-accent-focus: color-mix(");
  });

  test("provides all seven glass geometries from one material", () => {
    expect(source).toContain(".qali-glass {");
    for (const variant of [
      "dock",
      "panel",
      "menu",
      "tooltip",
      "toast",
      "composer",
      "shell",
    ]) {
      expect(source).toContain(`.qali-glass--${variant}`);
    }
    expect(source).toContain("backdrop-filter: blur(var(--qali-glass-blur))");
    expect(source).toContain(".qali-glass::before");
    expect(source).toContain(".qali-shell-linework");
    expect(source).toContain("--qali-glass-panel-surface:");
    expect(source).toContain("html[data-qali-desktop] body");
    expect(source).toContain("background: transparent;");
  });

  test("draws workspace structural dividers as continuous one-pixel rules", () => {
    const linework = source.slice(
      source.indexOf(".qali-shell-linework {"),
      source.indexOf(".qali-settings-layout {"),
    );

    expect(linework).toContain("height: 1px;");
    expect(linework).toContain("width: 1px;");
    expect(linework).toContain("top: 0;");
    expect(linework).toContain("bottom: 0;");
    expect(linework).toContain("right: 0;");
    expect(linework).toContain("left: var(--qali-shell-rail);");
    expect(linework).toContain(
      "left: calc(var(--qali-shell-rail) - 1px);",
    );
    expect(linework).toContain(
      ".qali-shell-linework::before,\n  .qali-shell-linework::after",
    );
    expect(linework.match(/background: var\(--border\);/g)).toHaveLength(1);
    expect(linework).not.toContain("linear-gradient");
    expect(linework).not.toContain("transparent");
    expect(linework).not.toContain("--qali-glass-edge");
  });

  test("uses the T3 composer material construction instead of flat tinted panels", () => {
    expect(source).toContain("--qali-glass-opacity: 80%;");
    expect(source).toContain("--qali-glass-blur: 16px;");
    expect(source).toContain("--qali-glass-raised-surface:");
    expect(source).toContain("--qali-glass-grain:");
    expect(source.replace(/\s+/g, " ")).toContain(
      "background-image: var(--qali-glass-grain), linear-gradient",
    );
    expect(source).toContain("html[data-qali-desktop].dark");
    expect(source).toContain("rgb(24 24 24 / 0.46)");
    expect(source).toContain(".qali-glass::after");
    expect(source).toContain(
      "var(--qali-glass-raised-surface) var(--qali-glass-opacity)",
    );
    expect(source).toContain(
      ".qali-settings-layout {\n    background: transparent;",
    );
    expect(source).toContain(
      ".qali-settings-sidebar {\n    background: transparent;",
    );
    expect(components[4]).toContain('className="qali-goo-glass');
    expect(components[4]).toContain("qali-goo-backdrop");
  });

  test("keeps goo menus opaque and theme-aware without glass blur", () => {
    expect(source).toContain("--qali-goo-fill: var(--popover);");
    expect(source).toContain("--qali-goo-control-fill:");
    expect(source).toContain("--qali-goo-fill: #202020;");
    expect(source).toContain(".qali-goo-surface {");
    expect(components[4]).toContain(
      'const FILL = "var(--qali-goo-fill)";',
    );

    const gooRule = source.match(/\.qali-goo-glass\s*\{(?<body>[^}]*)\}/)
      ?.groups?.body;
    expect(gooRule).toBeDefined();
    expect(gooRule).not.toContain("backdrop-filter");
    expect(gooRule).not.toContain("background-image");
  });

  test("uses an opaque material when reduced transparency is requested", () => {
    expect(source).toContain("@media (prefers-reduced-transparency: reduce)");
    expect(source).toContain(
      "--qali-glass-surface: var(--qali-surface-raised-opaque);",
    );
    expect(source).toContain("backdrop-filter: none;");
  });

  test("keeps feedback and floating motion inside the approved bands", () => {
    expect(source).toContain("--qali-motion-feedback: 100ms;");
    expect(source).toContain("--qali-motion-enter: 160ms;");
    expect(source).toContain("--qali-motion-exit: 110ms;");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("shares control edges and overlap elevation across primitives", () => {
    expect(source).toContain(".qali-control {");
    expect(source).toContain(".qali-elevation-popover {");
    expect(components[0]).toContain("qali-control");
    expect(components[1]).toContain("qali-elevation-popover");
    expect(components[2]).toContain("qali-elevation-popover");
    expect(components[3]).toContain("qali-elevation-popover");
    expect(components[4]).toContain("qali-elevation-popover");
  });

  test("keeps the tooltip arrow on the popup material token", () => {
    expect(components[3]).toContain("qali-tooltip-arrow");
    expect(components[3]).not.toContain("bg-popover fill-popover");
    expect(source).toContain(".qali-tooltip-arrow {");
    expect(source).toContain("background: var(--qali-glass-surface);");
    expect(source).toContain("fill: var(--qali-glass-surface);");
  });

  test("does not apply blur or exterior shadow to calendar events", () => {
    const eventCardRule = source.match(/\.event-card\s*\{(?<body>[^}]*)\}/)
      ?.groups?.body;

    expect(eventCardRule).toBeDefined();
    expect(eventCardRule).not.toContain("backdrop-filter");
    expect(eventCardRule).not.toContain("box-shadow");
  });
});
