import { expect, test } from "bun:test";

import { mainWindowOptions } from "../src/main/window-options";

test("places the macOS traffic lights directly over the application surface", () => {
  expect(mainWindowOptions()).toMatchObject({
    backgroundColor: "#00000000",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    transparent: true,
    vibrancy: "sidebar",
    visualEffectState: "active",
  });
  expect(mainWindowOptions()).not.toHaveProperty("frame", false);
});
