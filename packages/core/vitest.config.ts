import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL("./src/test/setup.ts", import.meta.url))],
  },
});
