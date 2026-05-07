// Single source of truth for backend URL resolution across the app.
//
// Three resolution modes, in priority order:
//   1. VITE_BACKEND_*_URL env var explicitly set → use it as-is.
//   2. Production build (Vite MODE === "production") → relative URL for
//      HTTP (empty base, so `${HTTP_BASE}/api/foo` becomes `/api/foo`),
//      and a WS URL computed from window.location at module-load time
//      (matches the page's origin, with wss:// when the page is HTTPS).
//   3. Otherwise (dev) → localhost:8000 default for both.
//
// Mode 2 is the single-service Railway deploy: FastAPI serves
// frontend/dist/ from the same origin as the API, so relative URLs and
// same-host WS resolve to the deployed Railway hostname automatically —
// no VITE_BACKEND_*_URL env var configuration needed at deploy time.
// This eliminates the chicken-and-egg of "deploy first to get the URL,
// then set the env var, then redeploy".
//
// To override (e.g. kiosk and dashboard on different subdomains pointing
// at a separate API host), set VITE_BACKEND_HTTP_URL + VITE_BACKEND_WS_URL
// in `.env.production` before running `npm run build`.

const explicitHttp = import.meta.env.VITE_BACKEND_HTTP_URL;
const explicitWs = import.meta.env.VITE_BACKEND_WS_URL;
const isProd = import.meta.env.MODE === "production";

function deriveProdWsBase() {
  if (typeof window === "undefined" || !window.location) return "";
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}`;
}

export const HTTP_BASE =
  explicitHttp != null && explicitHttp !== ""
    ? explicitHttp
    : isProd
    ? ""
    : "http://localhost:8000";

export const WS_BASE =
  explicitWs != null && explicitWs !== ""
    ? explicitWs
    : isProd
    ? deriveProdWsBase()
    : "ws://localhost:8000";
