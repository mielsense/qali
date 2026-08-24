// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test"
// @ts-expect-error Source-contract tests run in Bun; the UI package excludes Node globals.
import { readFileSync } from "node:fs"

const source = readFileSync(
  new URL("./evil-area-chart.tsx", import.meta.url),
  "utf8",
)

describe("Evil area chart visual contract", () => {
  test("keeps the EvilCharts interaction and accessibility patterns", () => {
    expect(source).toContain("accessibilityLayer")
    expect(source).toContain('strokeDasharray: "3 5"')
    expect(source).toContain("grid-dots")
    expect(source).toContain("useReducedMotion")
    expect(source).toContain('clipPath: "inset(0 100% 0 0)"')
  })
})
