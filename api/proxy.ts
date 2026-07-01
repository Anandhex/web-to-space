export const config = { runtime: "edge" };

/**
 * Generic CORS proxy — forwards any URL server-side so the browser
 * never hits cross-origin restrictions.  Handles HTML, images, fonts,
 * and any other content type.  Responses are cached for 1 hour.
 *
 * Usage:  /api/proxy?url=https://example.com/path
 */
export default async function handler(req: Request): Promise<Response> {
  // Handle pre-flight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get("url");

  if (!targetUrl) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // Validate the URL
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return new Response("Invalid url parameter", { status: 400 });
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new Response("Only http/https URLs are supported", { status: 400 });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; WebToSpace/1.0)",
        // Forward the Accept header so image requests get image responses
        Accept: req.headers.get("Accept") ?? "*/*",
      },
      // Edge runtime: follow redirects automatically
      redirect: "follow",
    });

    const contentType =
      upstream.headers.get("content-type") ?? "application/octet-stream";

    // Stream the body through as an ArrayBuffer so binary data (images,
    // fonts, etc.) is preserved without any text encoding corruption.
    const body = await upstream.arrayBuffer();

    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        // Cache images / fonts aggressively; HTML for a shorter window
        "Cache-Control": contentType.startsWith("text/html")
          ? "public, max-age=60"
          : "public, max-age=3600, immutable",
      },
    });
  } catch (err) {
    return new Response(`Proxy error: ${String(err)}`, {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
}
