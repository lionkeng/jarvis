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
        demo: fileURLToPath(new URL("./index.html", import.meta.url)),
        embed: fileURLToPath(new URL("./embed.html", import.meta.url)),
        voice: fileURLToPath(new URL("./voice.html", import.meta.url)),
      },
    },
  },
});
