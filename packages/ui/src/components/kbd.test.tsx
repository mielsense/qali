// @ts-expect-error Bun supplies its test module at runtime; this package's
// TypeScript config intentionally omits runner globals.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Kbd, KbdGroup } from "./kbd";

test("renders shortcut keys as semantic key caps", () => {
  const markup = renderToStaticMarkup(
    <KbdGroup aria-label="Command K">
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>,
  );

  expect(markup).toContain("<kbd");
  expect(markup.match(/<kbd/g)?.length).toBe(2);
  expect(markup).toContain('aria-label="Command K"');
  expect(markup).toContain(">⌘</kbd>");
  expect(markup).toContain(">K</kbd>");
});
