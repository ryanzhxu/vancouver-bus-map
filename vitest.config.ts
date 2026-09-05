import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Worker code, build scripts, and the browser client all use plain
    // functions here, so one Node environment covers every suite.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "web/src/**/*.test.ts"],
  },
});
