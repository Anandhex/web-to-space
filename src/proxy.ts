/**
 * proxy.ts
 *
 * Single source of truth for the dev-only CORS proxy URL shape. The proxy is
 * registered as a Vite middleware (`/api/proxy?url=`) and is NOT available in
 * the production build — see vite.config.ts.
 */

/** Wrap a URL so it is fetched through the dev CORS proxy. */
export function proxyUrl(url: string): string {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

/**
 * Route an <img>/poster src through the CORS proxy so cross-origin images can
 * be loaded as WebGL textures. Data, blob, relative and already-same-origin
 * (`/…`) URLs pass through unchanged.
 */
export function proxyImageSrc(src: string): string {
  if (
    !src ||
    src.startsWith("data:") ||
    src.startsWith("blob:") ||
    src.startsWith("/")
  ) {
    return src;
  }
  try {
    const u = new URL(src);
    if (u.protocol === "http:" || u.protocol === "https:") {
      return proxyUrl(src);
    }
  } catch {
    // relative URL — leave as-is
  }
  return src;
}
