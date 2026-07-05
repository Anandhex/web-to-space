import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

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

export default defineConfig({
  plugins: [corsProxyPlugin(), react()],
  server: {
    // 0.0.0.0 so a headset on the same LAN can reach this machine's HTTPS
    // dev server directly (e.g. https://<your-ip>:5173) — WebXR requires a
    // secure context, and "secure context" only covers localhost, not a
    // LAN IP over plain http.
    host: true,
  },
});
