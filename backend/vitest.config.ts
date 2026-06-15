import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Resolve the `#modules/*` subpath imports (declared in package.json `imports`) to the
// TypeScript source, so unit tests can import — and vi.mock — those modules with the
// same specifier the application code uses.
export default defineConfig({
  resolve: {
    alias: {
      "#modules": fileURLToPath(new URL("./src/modules", import.meta.url)),
    },
  },
});
