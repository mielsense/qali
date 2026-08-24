// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";

import { buttonVariants } from "./button";
import { cardVariants } from "./card";
import { surfaceVariants } from "./surface";
import { tabsListVariants } from "./tabs";
import { SegmentedControl } from "./segmented-control";

describe("Qali design system primitives", () => {
  test("exposes semantic control elevations instead of page-specific classes", () => {
    expect(buttonVariants({ variant: "default" })).toContain("qali-control--accent");
    expect(buttonVariants({ variant: "quiet" })).toContain("qali-control--quiet");
    expect(buttonVariants({ variant: "raised" })).toContain("qali-control--raised");
    expect(buttonVariants({ variant: "accent" })).toContain("qali-control--accent");
  });

  test("gives content surfaces explicit depth roles", () => {
    expect(surfaceVariants({ depth: "flat" })).toContain("qali-surface--flat");
    expect(surfaceVariants({ depth: "raised" })).toContain("qali-surface--raised");
    expect(surfaceVariants({ depth: "floating" })).toContain("qali-surface--floating");
    expect(cardVariants({ variant: "metric" })).toContain("qali-card--metric");
  });

  test("uses the same raised control material for segmented tabs", () => {
    expect(tabsListVariants({ variant: "raised" })).toContain("qali-segmented");
  });

  test("centralizes segmented controls with Motion selection feedback", () => {
    expect(typeof SegmentedControl).toBe("function");
  });
});
