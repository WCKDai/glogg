/**
 * Request guard for the local API.
 *
 * glogg runs on your machine and holds your keys (debrid, cloud storage, AI),
 * and any page you visit can send requests to localhost. So apart from a few
 * read-only public routes, the API only answers glogg itself (same origin),
 * browser extensions, clients that send no Origin (the CLI, curl, scripts) and
 * origins you allow. The Host check stops DNS-rebinding pages from posing as
 * same-origin.
 *
 *   GLOGG_ALLOWED_ORIGINS  extra origins, comma-separated (https://glogg.example.com)
 *   GLOGG_ALLOWED_HOSTS    extra Host names behind a proxy or custom domain, or URLs (https://glogg.example.com,
 *                          as Coolify's SERVICE_FQDN_* gives them); "*" disables the check
 */
import net from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/** Read-only routes any site may call: OpenSearch, suggestions, the Atlas, health. */
const PUBLIC_PATHS: RegExp[] = [
  /^\/api\/health$/,
  /^\/api\/search$/,
  /^\/api\/opensearch\/suggest$/,
  /^\/api\/directory$/,
  /^\/api\/ipfs\/[^/]+$/,
  /^\/opensearch\.xml$/,
];

const EXTENSION_PROTOCOLS = new Set(['chrome-extension:', 'moz-extension:', 'safari-web-extension:']);

type Env = Record<string, string | undefined>;

function envList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(path));
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
  if (EXTENSION_PROTOCOLS.has(url.protocol)) return true;
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
  const isApi = req.path.startsWith('/api/');
  if (isPublicPath(req.path)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
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
  // Allowed cross-origin callers (an extension, GLOGG_ALLOWED_ORIGINS) get their own origin back.
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
