import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": r("./src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration suites each work in their own Postgres schema, so files can run in parallel.
    testTimeout: 20_000,
  },
});
