// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./time-strip.tsx", import.meta.url), "utf8");

describe("time strip sticky contract", () => {
  test("gives both sticky header containing blocks the full timeline height", () => {
    expect(source).toContain("const laneHeight = timeStripLaneMinHeight");
    expect(source.match(/height: laneHeight/g)).toHaveLength(2);
    expect(source).toContain("sticky left-0 z-[60] shrink-0 self-start");
  });
});
