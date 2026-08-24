import { query } from "./_generated/server";
import { optionalLocalUser } from "./domains/desktop/identity";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const authUser = await optionalLocalUser(ctx);
    if (!authUser) {
      return {
        message: "Not authenticated",
      };
    }
    return {
      message: "This is private",
    };
  },
});
