// @ts-expect-error Bun supplies its test module at runtime; the web app's
// TypeScript config intentionally includes browser globals only.
import { describe, expect, it, mock } from "bun:test";

import { COMMAND_MENU_ITEMS } from "./command-menu-items";
import { runCommandMenuItem } from "./command-menu-action";

function item(id: string) {
  const result = COMMAND_MENU_ITEMS.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing command-menu item: ${id}`);
  return result;
}

describe("runCommandMenuItem", () => {
  it("navigates route items directly", async () => {
    const navigate = mock();
    const dispatch = mock(() => false);

    await runCommandMenuItem(item("navigate.insights"), { navigate, dispatch });

    expect(navigate).toHaveBeenCalledWith({ to: "/insights" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("runs commands already owned by the workspace", async () => {
    const navigate = mock();
    const dispatch = mock(() => true);

    await runCommandMenuItem(item("assistant.toggle"), { navigate, dispatch });

    expect(dispatch).toHaveBeenCalledWith("assistant.toggle");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the calendar before retrying a calendar-only command", async () => {
    const navigate = mock();
    const afterNavigation = mock();
    const dispatch = mock()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await runCommandMenuItem(item("calendar.view.week"), {
      navigate,
      dispatch,
      afterNavigation,
    });

    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    expect(afterNavigation).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenNthCalledWith(1, "calendar.view.week");
    expect(dispatch).toHaveBeenNthCalledWith(2, "calendar.view.week");
  });
});
