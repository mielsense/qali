// @ts-expect-error Bun supplies its test module at runtime.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RichTextEditor } from "./rich-text-editor";

test("defers document creation until commit instead of initializing during render", () => {
  // Suspense can abandon a render before commit. No editor (or schema access)
  // should be created by this render-only pass, including for existing drafts.
  for (const value of ["", "<p>A saved <strong>description</strong></p>"]) {
    const markup = renderToStaticMarkup(
      <RichTextEditor
        value={value}
        autoFocus
        onChange={() => {
          throw new Error("Rendering must not overwrite the draft");
        }}
      />,
    );
    expect(markup).not.toContain("contenteditable");
    expect(markup).not.toContain('aria-label="Bold"');
  }
});
