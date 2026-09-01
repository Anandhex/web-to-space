import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import fs from "node:fs";
import path from "node:path";

function corsProxyPlugin(): Plugin {
  return {
    name: "cors-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy", async (req, res) => {
        const urlParam = new URL(
          req.url ?? "",
          "http://localhost",
        ).searchParams.get("url");

        if (!urlParam) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing url parameter");
          return;
        }

        try {
          const response = await fetch(urlParam, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; WebToSpace/1.0)",
            },
          });
          const contentType = response.headers.get("content-type") ?? "application/octet-stream";
          const body = Buffer.from(await response.arrayBuffer());
          res.writeHead(response.status, {
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Proxy error: ${String(err)}`);
        }
      });
    },
  };
}


/**
 * Log sink for src/study/logger.ts. `POST /api/study` appends one JSON line
 * per event to `study-out/P<nn>.jsonl` — the participant code in the body
 * picks the file, so every device logging over LAN (the headset, the
 * operator's runner tab) lands in the same place without any of them
 * knowing a filesystem exists. Dev-only, like `corsProxyPlugin` beside it:
 * a study session runs against `npm run dev`, never a static build.
 */
function studyLogPlugin(): Plugin {
  return {
    name: "study-log",
    configureServer(server) {
      const outDir = path.resolve(server.config.root, "study-out");
      server.middlewares.use("/api/study", async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("POST only");
          return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = Buffer.concat(chunks).toString("utf-8");
          const line = JSON.parse(body) as { participant?: string };
          const participant = (line.participant ?? "unknown").replace(
            /[^A-Za-z0-9_-]/g,
            "_",
          );
          fs.mkdirSync(outDir, { recursive: true });
          fs.appendFileSync(
            path.join(outDir, `${participant}.jsonl`),
            body.trimEnd() + "\n",
            "utf-8",
          );
          res.writeHead(204);
          res.end();
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`study-log error: ${String(err)}`);
        }
      });
    },
  };
}

// WebXR needs a secure context (HTTPS), so basic-ssl is on by default. Set
// NO_SSL=1 to serve plain HTTP — useful for local previews/tools that can't
// follow a self-signed cert (WebXR won't work in that mode, but the 2D view does).
const useSsl = process.env.NO_SSL !== "1";

export default defineConfig({
  plugins: [
    corsProxyPlugin(),
    studyLogPlugin(),
    react(),
    ...(useSsl ? [basicSsl()] : []),
  ],
  server: {
    // 0.0.0.0 so a headset on the same LAN can reach this machine's HTTPS
    // dev server directly (e.g. https://<your-ip>:5173) — WebXR requires a
    // secure context, and "secure context" only covers localhost, not a
    // LAN IP over plain http.
    host: true,
  },
});
