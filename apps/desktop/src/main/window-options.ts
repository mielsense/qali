import type { BrowserWindowConstructorOptions } from "electron";

/** Native window chrome shared by every Qali window. `hiddenInset` keeps the
 * standard close/minimize/zoom controls while placing them directly over the
 * application surface instead of reserving an inset titlebar band. The native
 * sidebar material is the actual macOS blur layer; renderer glass remains
 * translucent enough for that material to show through. */
export function mainWindowOptions(): Pick<
  BrowserWindowConstructorOptions,
  | "backgroundColor"
  | "titleBarStyle"
  | "trafficLightPosition"
  | "transparent"
  | "vibrancy"
  | "visualEffectState"
> {
  return {
    backgroundColor: "#00000000",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    transparent: true,
    vibrancy: "sidebar",
    visualEffectState: "active",
  };
}
