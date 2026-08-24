import { defineConfig } from "vitest/config";

// convex-test integration tests run in the edge runtime and load the whole
// function surface via import.meta.glob. They live in `*.itest.ts` files so the
// `bun test` pure-helper suite (`*.test.ts`) and this suite never pick up each
// other's files.
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.itest.ts"],
    server: { deps: { inline: ["convex-test"] } },
    // Assistant modules validate deployment environment values at import time.
    // These fixtures exercise local DB logic only, so no live credentials exist.
    env: {
      SKIP_ENV_VALIDATION: "1",
      QALI_LOCAL_AUTH_CHANNEL: "test",
    },
  },
});
