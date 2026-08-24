import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@qali/ui/lib/utils"

const glassSurfaceVariants = cva("qali-glass", {
  variants: {
    variant: {
      dock: "qali-glass--dock",
      panel: "qali-glass--panel",
      menu: "qali-glass--menu",
      tooltip: "qali-glass--tooltip",
      toast: "qali-glass--toast",
      composer: "qali-glass--composer",
      shell: "qali-glass--shell",
    },
  },
  defaultVariants: {
    variant: "panel",
  },
})

type GlassSurfaceVariant = NonNullable<
  VariantProps<typeof glassSurfaceVariants>["variant"]
>

function GlassSurface({
  className,
  variant = "panel",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof glassSurfaceVariants>) {
  return (
    <div
      data-slot="glass-surface"
      data-variant={variant}
      className={cn(glassSurfaceVariants({ variant }), className)}
      {...props}
    />
  )
}

export {
  GlassSurface,
  glassSurfaceVariants,
  type GlassSurfaceVariant,
}
