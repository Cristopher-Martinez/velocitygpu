import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.mjs"],
    environment: "node",
    coverage: {
      provider: "v8",
      // server.mjs is pure bootstrap (wiring + env fallbacks): it is validated
      // with a real startup smoke test, not with unit branch coverage.
      include: ["src/**/*.mjs"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
