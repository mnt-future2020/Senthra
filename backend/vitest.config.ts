import { fileURLToPath } from "node:url";

import { defineConfig, configDefaults } from "vitest/config";

// Resolve the `#modules/*` subpath imports (declared in package.json `imports`) to the
// TypeScript source, so unit tests can import — and vi.mock — those modules with the
// same specifier the application code uses.
export default defineConfig({
  resolve: {
    alias: {
      "#modules": fileURLToPath(new URL("./src/modules", import.meta.url)),
    },
  },
  test: {
    // Only run tests from the TypeScript source — never the compiled `dist/` output. A stale
    // build in dist/ would otherwise be picked up and fail (or duplicate) after src changes.
    include: ["src/**/*.{test,spec}.ts"],
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
