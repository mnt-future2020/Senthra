import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit-test config. Mirrors the app's "@/..." path alias (tsconfig paths) so tests resolve
// modules exactly as Next.js does. Tests run in Node by default; jsdom is opt-in per file.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
