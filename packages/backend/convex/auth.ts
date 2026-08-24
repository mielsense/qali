import { query } from "./_generated/server";
import { optionalLocalUser } from "./domains/desktop/identity";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return await optionalLocalUser(ctx);
  },
});
