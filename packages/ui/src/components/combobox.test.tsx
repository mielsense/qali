// @ts-expect-error Bun supplies its test module at runtime.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Combobox, ComboboxInput } from "./combobox";

describe("combobox accessible controls", () => {
  test("names the group, trigger, and clear action for the owning field", () => {
    const html = renderToStaticMarkup(
      <Combobox items={["Europe/Paris"]} value="Europe/Paris">
        <ComboboxInput
          aria-label="Primary time zone"
          showClear
        />
      </Combobox>,
    );

    expect(html).toContain('aria-label="Primary time zone controls"');
    expect(html).toContain('aria-label="Show Primary time zone options"');
    expect(html).toContain('aria-label="Clear Primary time zone"');
  });
});
