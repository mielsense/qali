import * as React from "react"

import { Button } from "@qali/ui/components/button"
import { cn } from "@qali/ui/lib/utils"

type FloatingControlProps = Omit<
  React.ComponentProps<typeof Button>,
  "size" | "variant"
> & {
  size?: "default" | "launcher"
}

function FloatingControl({
  className,
  size = "default",
  ...props
}: FloatingControlProps) {
  return (
    <Button
      data-slot="floating-control"
      data-size={size}
      variant="glass"
      size={size === "launcher" ? "icon-lg" : "icon"}
      className={cn(
        "qali-floating-control",
        className
      )}
      {...props}
    />
  )
}

export { FloatingControl, type FloatingControlProps }
