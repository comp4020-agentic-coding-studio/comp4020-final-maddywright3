import { defineConfig } from "vitest/config";

// Every test in spec/ runs against the running app, which spec/global-setup.ts
// finds. Only spec/ runs: a test anywhere else needs adding to `include`.
export default defineConfig({
  test: {
    include: ["spec/**/*.test.ts"],
    globalSetup: ["./spec/global-setup.ts"],
    // Every spec file shares the one live app and the one demo lecture, so
    // two files' tests racing on its presence/tap count is a real collision,
    // not a fluke (hit once C10 added a third file tapping demo). Running
    // spec files one at a time avoids that without faking isolated state.
    fileParallelism: false,
  },
});
