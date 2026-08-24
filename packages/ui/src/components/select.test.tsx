// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Select,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

describe("select accessible trigger", () => {
  test("preserves the owning field name and selected label", () => {
    const items = [
      { label: "8 AM", value: 8 },
      { label: "9 AM", value: 9 },
    ];
    const html = renderToStaticMarkup(
      <Select items={items} value={8}>
        <SelectTrigger aria-label="First visible hour">
          <SelectValue />
        </SelectTrigger>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </Select>,
    );

    expect(html).toContain('aria-label="First visible hour"');
    expect(html).toContain("8 AM");
  });
});
