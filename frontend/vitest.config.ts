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
  test: {
    // Next.js loads .env itself at build/dev time; vitest does not. Modules under src/lib read
    // NEXT_PUBLIC_* at import time (lib/env.ts THROWS when NEXT_PUBLIC_API_URL is unset), so
    // without this, importing anything that touches lib/env fails the whole file. A literal test
    // value keeps the suite hermetic — no test should depend on the developer's local .env.
    env: {
      NEXT_PUBLIC_API_URL: "http://localhost:8000",
    },
  },
});
