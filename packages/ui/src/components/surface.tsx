import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@qali/ui/lib/utils"

const surfaceVariants = cva("qali-surface", {
  variants: {
    depth: {
      flat: "qali-surface--flat",
      raised: "qali-surface--raised",
      floating: "qali-surface--floating",
      inset: "qali-surface--inset",
    },
    radius: {
      default: "rounded-2xl",
      compact: "rounded-xl",
      panel: "rounded-3xl",
      pill: "rounded-full",
    },
  },
  defaultVariants: {
    depth: "flat",
    radius: "default",
  },
})

function Surface({
  className,
  depth = "flat",
  radius = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof surfaceVariants>) {
  return (
    <div
      data-slot="surface"
      data-depth={depth}
      className={cn(surfaceVariants({ depth, radius }), className)}
      {...props}
    />
  )
}

export { Surface, surfaceVariants }
