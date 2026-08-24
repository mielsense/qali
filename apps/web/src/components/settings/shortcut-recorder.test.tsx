// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ShortcutRecorder } from "./shortcut-recorder";

test("renders each part of a shortcut as a semantic key cap", () => {
  const markup = renderToStaticMarkup(
    <ShortcutRecorder
      commandLabel="Open command menu"
      value={{ key: "K", modifiers: ["shift", "meta"] }}
      onChange={() => undefined}
    />,
  );

  expect(markup.match(/<kbd/g)?.length).toBe(3);
  expect(markup).toContain(">⌘</kbd>");
  expect(markup).toContain(">⇧</kbd>");
  expect(markup).toContain(">K</kbd>");
  expect(markup).toContain(
    'aria-label="Change Open command menu keybinding, currently Command Shift K"',
  );
});

test("announces a conflicting shortcut next to the recorder", () => {
  const markup = renderToStaticMarkup(
    <ShortcutRecorder
      commandLabel="Open command menu"
      value={{ key: "K", modifiers: ["meta"] }}
      conflicts={["Open assistant"]}
      onChange={() => undefined}
    />,
  );

  expect(markup).toContain('aria-invalid="true"');
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Conflicts with Open assistant");
});
