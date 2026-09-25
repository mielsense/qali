import * as React from "react";

/** Keep backdrop sampling in window coordinates. Chromium can leave the
 * translated portion of a frosted popup unblurred inside a transparent window.
 * Base UI still owns collision handling and updates these coordinates. */
export function layoutPosition(style: React.CSSProperties | undefined) {
  const match = style?.transform?.match(/^translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)$/);
  if (!match || (style?.left !== 0 && style?.left !== "0px") ||
      (style?.top !== 0 && style?.top !== "0px")) return style;
  return { ...style, left: Number(match[1]), top: Number(match[2]),
    transform: "none", willChange: "auto" };
}

export const FloatingPositioner = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function FloatingPositioner({ style, ...props }, ref) {
    return <div {...props} ref={ref} style={layoutPosition(style)} />;
  },
);
