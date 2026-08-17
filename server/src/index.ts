import { readConfig } from "./config.js";
import { createSessionRoute } from "./routes/session.js";

export function createServer(config = readConfig()) {
  const sessionRoute = createSessionRoute({ config });
  return Bun.serve({
    port: config.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true, runtime: "bun" });
      if (url.pathname === "/session") return sessionRoute(request);
      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
}

if (import.meta.main) {
  const config = readConfig();
  const server = createServer(config);
  console.log(`Jarvis session BFF listening on http://localhost:${server.port}`);
}
