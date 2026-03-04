import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/__tests__/**/*.test.ts",
      "packages/sdk/src/**/__tests__/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: [
        "src/**/*.ts",
        "packages/sdk/src/**/*.ts",
      ],
      exclude: [
        "**/__tests__/**",
        "**/node_modules/**",
        "**/dist/**",
      ],
      thresholds: {
        statements: 18.49,
        branches: 15.59,
        functions: 21.86,
        lines: 18.65,
        autoUpdate: true,
      },
    },
    // Longer timeout for tests that import heavy deps (GramJS, @ton/ton)
    testTimeout: 10_000,
  },
});