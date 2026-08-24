"use client"

import { useTheme } from "next-themes"
import { Toaster as SileoToaster } from "sileo"
import type { ComponentProps } from "react"

type ToasterProps = ComponentProps<typeof SileoToaster>

const Toaster = ({ options, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <SileoToaster
      theme={theme as ToasterProps["theme"]}
      options={{
        fill: "var(--popover)",
        roundness: 16,
        duration: 4_500,
        ...options,
      }}
      {...props}
    />
  )
}

export { Toaster }
