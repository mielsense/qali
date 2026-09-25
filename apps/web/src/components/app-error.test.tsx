// @ts-expect-error Bun supplies its test module at runtime.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AppErrorScreen } from "./app-error";

test("recovery renders without application providers and offers a reload", () => {
  const markup = renderToStaticMarkup(<AppErrorScreen />);
  expect(markup).toContain("<main");
  expect(markup).toContain("<h1");
  expect(markup).toContain("Reload app</button>");
  expect(markup).toContain("haven’t saved may be lost");
  expect(markup).toContain("[-webkit-app-region:no-drag]");
});
