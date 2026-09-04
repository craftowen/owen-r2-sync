import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          SYNC_TOKEN: "test-sync-token-with-at-least-32-bytes",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    coverage: {
      provider: "istanbul",
    },
    include: ["test/**/*.test.ts"],
  },
});
