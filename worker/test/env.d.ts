/// <reference types="@cloudflare/vitest-plugin/types" />

declare module "cloudflare:test" {
  interface ProvidedEnv {
    SYNC_TOKEN: string;
  }
}
