/**
 * Request guard for the local API.
 *
 * glogg runs on your machine and holds your keys (debrid, cloud storage, AI),
 * and any page you visit can send requests to localhost. So apart from a few
 * read-only public routes (GET only), the API only answers glogg itself (same
 * origin), clients that send no Origin (the CLI, curl, scripts) and origins
 * you allow, browser extensions included. The Host check stops DNS-rebinding
 * pages from posing as same-origin.
 *
 *   GLOGG_ALLOWED_ORIGINS  extra origins, comma-separated (https://glogg.example.com,
 *                          chrome-extension://<id> for an extension of your own)
 *   GLOGG_ALLOWED_HOSTS    extra Host names behind a proxy or custom domain, or URLs (https://glogg.example.com,
 *                          as Coolify's SERVICE_FQDN_* gives them); "*" disables the check
 */
import crypto from 'node:crypto';
import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/**
 * Read-only routes any site may call, with GET: OpenSearch, suggestions, the
 * Atlas, health. Only GET, because a POST to /api/search can carry indexer
 * addresses, and glogg would send your stored keys along to them.
 */
const PUBLIC_PATHS: RegExp[] = [
  /^\/api\/health$/,
  /^\/api\/capabilities$/,
  /^\/api\/sources$/,
  /^\/api\/search$/,
  /^\/api\/opensearch\/suggest$/,
  /^\/api\/directory$/,
  /^\/api\/ipfs\/[^/]+$/,
  /^\/opensearch\.xml$/,
];

const PUBLIC_METHODS = new Set(['GET', 'HEAD']);

type Env = Record<string, string | undefined>;

function envList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** `method` is the one the request makes, or for a preflight, the one it asks to make. */
export function isPublicPath(path: string, method = 'GET'): boolean {
  return PUBLIC_METHODS.has(method.toUpperCase()) && PUBLIC_PATHS.some((re) => re.test(path.toLowerCase()));
}

/** "[::1]:4173" → "::1", "Localhost:4173" → "localhost" */
export function hostName(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

/** "https://glogg.example.com/" → "glogg.example.com"; plain host names pass through. */
function hostEntry(entry: string): string {
  if (!entry.includes('://')) return entry;
  try {
    return new URL(entry).host;
  } catch {
    return entry;
  }
}

export function isAllowedHost(hostHeader: string | undefined, env: Env = process.env): boolean {
  // Browsers always send Host, so a request without one isn't a web page.
  if (!hostHeader) return true;
  const allowed = envList(env.GLOGG_ALLOWED_HOSTS).map(hostEntry);
  if (allowed.includes('*')) return true;
  const name = hostName(hostHeader);
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true;
  if (net.isIP(name)) return true;
  return allowed.includes(name) || allowed.includes(hostHeader.trim().toLowerCase());
}

export function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined, env: Env = process.env): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (hostHeader && url.host === hostHeader.trim().toLowerCase()) return true;
  return envList(env.GLOGG_ALLOWED_ORIGINS).includes(origin.toLowerCase());
}

/** Why a request to a private route is refused, or null when it may proceed. */
export function rejectReason(
  req: { headers: Record<string, string | string[] | undefined> },
  env: Env = process.env
): string | null {
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const host = header('host');
  if (!isAllowedHost(host, env)) {
    return `Host "${host}" isn't allowed. Set GLOGG_ALLOWED_HOSTS=${hostName(host || '')} to serve glogg under that name.`;
  }
  const origin = header('origin');
  if (!isAllowedOrigin(origin, host, env)) {
    return `Requests from ${origin} aren't allowed. Add it to GLOGG_ALLOWED_ORIGINS if you trust it.`;
  }
  if (origin === undefined && header('sec-fetch-site') === 'cross-site') {
    return 'Cross-site requests aren\'t allowed.';
  }
  return null;
}

export function apiGuard(req: Request, res: Response, next: NextFunction): void {
  // Routes are case-sensitive, but "/API/…" is still treated as the API here.
  const isApi = req.path.toLowerCase().startsWith('/api/');
  const preflight = req.method === 'OPTIONS';
  const method = preflight ? String(req.headers['access-control-request-method'] || 'GET') : req.method;
  if (isPublicPath(req.path, method)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (preflight) {
      res.status(204).end();
      return;
    }
    next();
    return;
  }
  if (!isApi) {
    next();
    return;
  }
  const reason = rejectReason(req);
  if (reason) {
    res.status(403).json({ error: reason });
    return;
  }
  // Allowed cross-origin callers (GLOGG_ALLOWED_ORIGINS) get their own origin back.
  const origin = req.headers.origin;
  if (origin && origin !== `${req.protocol}://${req.headers.host}`) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * The page's Content Security Policy: only glogg's own scripts (the inline
 * theme script by its hash), styles and images; video playback may contact
 * Wikimedia only after the user presses Play. No framing, plugins or <base>.
 */
export function contentSecurityPolicy(indexHtml: string): string {
  const inline = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`
  );
  return [
    "default-src 'self'",
    ["script-src 'self'", ...inline].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' https://upload.wikimedia.org",
    "connect-src 'self'",
    "font-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * On every response: no MIME sniffing, no framing, and no Referer, so the
 * sites you open from glogg never see the search that led there.
 */
export function securityHeaders(csp?: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (csp) res.setHeader('Content-Security-Policy', csp);
    next();
  };
}
