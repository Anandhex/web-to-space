import { defineConfig } from "vite";
import type { Plugin } from "vite";

function corsProxyPlugin(): Plugin {
  return {
    name: "cors-proxy",
    configureServer(server) {
      server.middlewares.use("/proxy", async (req, res) => {
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
          const html = await response.text();
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Proxy error: ${String(err)}`);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [corsProxyPlugin()],
});
