/**
 * Build a WebSocket URL that points at the FastAPI backend, not the Next.js
 * host serving the page. In local dev the two are usually the same (Next dev
 * proxies the WS through `/quorums/:path*` rewrites). In Vercel production
 * they are not — Vercel's edge does NOT forward WS upgrades through
 * next.config.mjs rewrites, so deriving the WS host from window.location
 * routes the connection at Vercel and 404s.
 *
 * The right source of truth is the same env var the HTTP rewrites use:
 * NEXT_PUBLIC_API_URL (e.g. https://quorum-api-production.up.railway.app).
 * Falls back to window.location for local dev when the var isn't set.
 */
export function buildWsUrl(path: string): string {
  const apiBase =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) ||
    `${window.location.protocol}//${window.location.host}`;
  const wsBase = apiBase.replace(/^http/, "ws");
  return `${wsBase}${path.startsWith("/") ? "" : "/"}${path}`;
}
