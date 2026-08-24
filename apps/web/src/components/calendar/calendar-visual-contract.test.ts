// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("calendar visual contracts", () => {
  test("renders weekday and date in one inline label with a flat edge", () => {
    const header = read("./panel-header.tsx");
    const month = read("./month-panel.tsx");

    expect(header).toContain("inline-flex min-w-0 items-center");
    expect(header).toContain("border-b border-border");
    expect(header).not.toContain("border-y border-border");
    expect(header).not.toContain("shadow-bevel");
    expect(month).toContain("border-b border-border bg-calendar-header");
    expect(month).not.toContain("border-y border-border");
  });

  test("keeps reference clocks quiet and the primary clock next to the grid", () => {
    const gutter = read("./gutter-column.tsx");

    expect(gutter).toContain("calendarTimeZoneColumns");
    expect(gutter).toContain('zone.kind === "primary"');
    expect(gutter).not.toContain("last:border-r-0");
    expect(gutter).not.toContain('zone.kind === "primary" && "border-r');
    expect(gutter).toContain('new Intl.DateTimeFormat("en-GB"');
    expect(gutter).toContain('hourCycle: "h23"');
    expect(gutter).toContain("paddingInline: TIME_ZONE_GUTTER_PADDING");
    expect(gutter).toContain("items-center justify-center");
  });

  test("keeps the calendar selector on the dark-safe goo palette", () => {
    const calendar = read("./calendar.tsx");

    expect(calendar).toContain('fill="var(--qali-goo-fill)"');
    expect(calendar).toContain('activeFill="var(--qali-goo-fill)"');
    expect(calendar).not.toContain('activeFill="var(--primary)"');
  });

  test("builds both halves of the calendar toolbar from shared controls", () => {
    const calendar = read("./calendar.tsx");

    expect(calendar).toContain('<TabsList variant="raised"');
    expect(calendar).toContain('className="h-8 rounded-[8px] p-0.5"');
    expect(calendar).toContain("buttonRadius={8}");
    expect(calendar).toContain("<Button");
    expect(calendar).not.toContain("shadow-bevel");
    expect(calendar).not.toContain("<NavArrow");
  });

  test("gives the month and week picker a padded flat trigger", () => {
    const picker = read("./month-picker.tsx");

    expect(picker).toContain("h-8 gap-2 rounded-[8px] px-3");
    expect(picker).toContain("qali-control--raised");
    expect(picker).toContain("[--qali-glass-edge:var(--border)]");
    expect(picker).not.toContain("[--qali-shadow-attached:none]");
    expect(picker).not.toContain("!px-1");
    expect(picker).not.toContain('fill="transparent"');
    expect(picker).toContain("88 + weekRows * 38");
  });

  test("loads the rich description editor only when the description screen opens", () => {
    const form = read("./event-form.tsx");

    expect(form).toContain('import("./rich-text/rich-text-editor")');
    expect(form).toContain(
      "const RichTextEditorLazy = lazy(loadRichTextEditor)",
    );
    expect(form).toContain(
      "<Suspense fallback={<DescriptionEditorFallback />}",
    );
    expect(form).not.toContain(
      'import { RichTextEditor } from "./rich-text/rich-text-editor"',
    );
  });
});
