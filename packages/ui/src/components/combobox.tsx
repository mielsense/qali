"use client"

import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import { ArrowDown01Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@qali/ui/components/input-group"
import { cn } from "@qali/ui/lib/utils"

const Combobox = ComboboxPrimitive.Root

function ComboboxInput({
  className,
  disabled = false,
  showClear = false,
  "aria-label": ariaLabel,
  ...props
}: ComboboxPrimitive.Input.Props & { showClear?: boolean }) {
  const controlName = ariaLabel ?? "Combobox"
  return (
    <InputGroup
      aria-label={`${controlName} controls`}
      className={cn(
        "w-64 max-w-full rounded-lg border-input bg-background shadow-bevel",
        className,
      )}
    >
      <ComboboxPrimitive.Input
        aria-label={ariaLabel}
        render={<InputGroupInput disabled={disabled} />}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        {showClear ? (
          <ComboboxPrimitive.Clear
            aria-label={`Clear ${controlName}`}
            render={<InputGroupButton variant="ghost" size="icon-xs" />}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden="true" />
          </ComboboxPrimitive.Clear>
        ) : null}
        <ComboboxPrimitive.Trigger
          aria-label={`Show ${controlName} options`}
          render={<InputGroupButton variant="ghost" size="icon-xs" />}
          disabled={disabled}
        >
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} aria-hidden="true" />
        </ComboboxPrimitive.Trigger>
      </InputGroupAddon>
    </InputGroup>
  )
}

function ComboboxContent({ className, ...props }: ComboboxPrimitive.Popup.Props) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner sideOffset={6} className="isolate z-50">
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "w-(--anchor-width) max-w-(--available-width) overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      className={cn("max-h-64 scroll-py-1 overflow-y-auto overscroll-contain p-1", className)}
      {...props}
    />
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "relative flex cursor-default items-center rounded-lg py-2 pe-8 ps-2.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator className="absolute end-2 flex size-4 items-center justify-center">
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-hidden="true" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      className={cn("px-3 py-6 text-center text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList }
