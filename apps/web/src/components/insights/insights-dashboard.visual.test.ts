// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./insights-dashboard.tsx", import.meta.url),
  "utf8",
);

describe("Insights dashboard visual contract", () => {
  test("shares the compact calendar toolbar geometry", () => {
    expect(source).toContain(
      "qali-control--raised flex h-8 items-center rounded-xl",
    );
    expect(source).toContain("DataFrame");
  });

  test("uses Motion for dashboard entrance and data-bar changes", () => {
    expect(source).toContain("motion.section");
    expect(source).toContain("motion.div");
    expect(source).toContain("useReducedMotion");
  });

  test("uses the shared EvilCharts area-chart implementation", () => {
    expect(source).toContain(
      'import { EvilAreaChart } from "@qali/ui/components/evil-area-chart"',
    );
    expect(source).toContain("<EvilAreaChart");
    expect(source).not.toContain('from "recharts"');
  });
});
