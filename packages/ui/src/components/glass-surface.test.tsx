// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  GlassSurface,
  glassSurfaceVariants,
  type GlassSurfaceVariant,
} from "./glass-surface"
import { FloatingControl } from "./floating-control"

const variants: GlassSurfaceVariant[] = [
  "dock",
  "panel",
  "menu",
  "tooltip",
  "toast",
  "composer",
  "shell",
]

describe("GlassSurface", () => {
  test.each(variants)("renders the %s material variant", (variant: GlassSurfaceVariant) => {
    const markup = renderToStaticMarkup(
      <GlassSurface variant={variant}>Qali</GlassSurface>
    )

    expect(markup).toContain('data-slot="glass-surface"')
    expect(markup).toContain(`data-variant="${variant}"`)
    expect(markup).toContain("qali-glass")
    expect(markup).toContain(`qali-glass--${variant}`)
  })

  test("keeps the shared material class when callers add layout classes", () => {
    expect(glassSurfaceVariants({ variant: "composer", className: "mx-auto" }))
      .toContain("qali-glass qali-glass--composer mx-auto")
  })
})

describe("FloatingControl", () => {
  test("renders the shared circular dock material with an accessible name", () => {
    const markup = renderToStaticMarkup(
      <FloatingControl aria-label="Open assistant">Q</FloatingControl>
    )

    expect(markup).toContain('data-slot="floating-control"')
    expect(markup).toContain('aria-label="Open assistant"')
    expect(markup).toContain("qali-glass--dock")
    expect(markup).toContain("qali-floating-control")
  })
})
