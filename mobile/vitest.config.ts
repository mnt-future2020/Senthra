import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Node-only unit tests for the app's PURE modules — the rules it carries copies of.
//
// Every one of these files exists twice: once here and once in the web dashboard, because an
// engineer meets the same rule on a phone and in a browser. The web pins its copies with tests; this
// config is what lets the phone's copies be pinned by the same expectations, so the two cannot drift
// into disagreeing about a hire deadline, a return depot, or whether a code has expired.
//
// Deliberately NOT a React Native test setup: nothing here renders a component or imports from
// `react-native`. That keeps the runner plain Node with no Metro, no jest-expo preset and no native
// mocks to maintain — and it is why every module under test is written as a pure function in the
// first place.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` path in tsconfig.json, which some of these modules use for their types.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
