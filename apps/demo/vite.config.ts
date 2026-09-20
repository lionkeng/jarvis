import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        voice: fileURLToPath(new URL("./index.html", import.meta.url)),
        "jarvis-ui": fileURLToPath(new URL("./jarvis-ui.html", import.meta.url)),
        embed: fileURLToPath(new URL("./embed.html", import.meta.url)),
      },
    },
  },
});
