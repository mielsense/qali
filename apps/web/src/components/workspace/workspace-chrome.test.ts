// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  commitWorkspaceHeaderTarget,
  WORKSPACE_CHROME_GEOMETRY,
} from "./workspace-chrome";

describe("workspace chrome geometry", () => {
  test("forms one compact header-and-rail shell around the route content", () => {
    expect(WORKSPACE_CHROME_GEOMETRY).toMatchObject({
      headerHeight: 56,
      railWidth: 84,
      railContentStart: 56,
      chromeSurface: "calendar-background",
      singleSurface: true,
      geometricLinework: true,
    });
  });

  test("keeps header controls clear of the macOS traffic lights", () => {
    expect(WORKSPACE_CHROME_GEOMETRY.trafficLightSafeInset).toBeGreaterThan(
      WORKSPACE_CHROME_GEOMETRY.railWidth,
    );
  });

  test("publishes the header target as soon as the chrome commits", () => {
    const header = {} as HTMLElement;

    expect(commitWorkspaceHeaderTarget(null, header)).toBe(header);
  });

  test("provides a keyboard path past persistent workspace navigation", () => {
    const source = readFileSync(
      new URL("./workspace-chrome.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('href="#workspace-main"');
    expect(source).toContain('id="workspace-main"');
    expect(source).toContain("tabIndex={-1}");
  });
});
