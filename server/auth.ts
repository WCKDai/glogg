/**
 * Password protection, for glogg on a public address.
 *
 * Off unless GLOGG_PASSWORD (or GLOGG_PASSWORD_FILE, for Docker secrets) is
 * set; on your own machine glogg stays open, guarded by the request checks in
 * security.ts. With a password, every API route except health and sign-in
 * needs a session: an HttpOnly, SameSite=Strict cookie holding an expiry,
 * signed with a key derived from the password and a random secret kept in
 * $GLOGG_HOME. So sessions survive restarts, a new password signs everyone
 * out, and a stolen cookie can't be used to guess the password offline.
 * Sign-ins are rate-limited per address.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';

export const SESSION_COOKIE = 'glogg_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

/** Routes that answer without a session, so the app can load and offer the sign-in. */
const OPEN_PATHS = new Set(['/api/health', '/api/auth', '/api/auth/login', '/api/auth/logout']);

type Env = Record<string, string | undefined>;

/**
 * The configured password, or '' when glogg is open. A password file that is
 * set but unreadable or empty is an error: failing open would expose glogg.
 */
export function configuredPassword(env: Env = process.env): string {
  if (env.GLOGG_PASSWORD) return env.GLOGG_PASSWORD;
  const file = env.GLOGG_PASSWORD_FILE;
  if (!file) return '';
  let password = '';
  try {
    password = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    throw new Error(`GLOGG_PASSWORD_FILE is set but ${file} can't be read (${(e as NodeJS.ErrnoException).code ?? e}).`);
  }
  if (!password) throw new Error(`GLOGG_PASSWORD_FILE is set but ${file} is empty.`);
  return password;
}

/** The random secret that keys sessions, created on first use. Without a writable home, sessions last until restart. */
export function sessionSecret(home: string): Buffer {
  const file = path.join(home, 'session.key');
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } catch {
    const secret = crypto.randomBytes(32);
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch {
      // read-only home: keep this secret in memory
    }
    return secret;
  }
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest();

export interface Auth {
  /** True when a password is set. */
  readonly required: boolean;
  /** A session token valid until `now + SESSION_SECONDS`. */
  issue(now?: number): string;
  verify(token: string | undefined, now?: number): boolean;
  checkPassword(input: unknown): boolean;
  middleware(req: Request, res: Response, next: NextFunction): void;
  routes(app: Express): void;
}

export function createAuth(opts: { password: string; secret: Buffer; now?: () => number }): Auth {
  const now = opts.now ?? Date.now;
  const required = opts.password.length > 0;
  const key = crypto.createHmac('sha256', opts.secret).update(`glogg-session\0${opts.password}`).digest();
  const sign = (payload: string) => crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const failures = new Map<string, { count: number; resetAt: number }>();

  const issue = (at = now()) => {
    const expires = Math.floor(at / 1000) + SESSION_SECONDS;
    return `${expires}.${sign(`v1.${expires}`)}`;
  };

  const verify = (token: string | undefined, at = now()) => {
    const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
    if (!m || Number(m[1]) * 1000 <= at) return false;
    const expected = Buffer.from(sign(`v1.${m[1]}`));
    const given = Buffer.from(m[2]);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  // Comparing digests keeps the comparison constant-time whatever the input's length.
  const checkPassword = (input: unknown) => typeof input === 'string' && crypto.timingSafeEqual(sha256(input), sha256(opts.password));

  const cookie = (req: Request) =>
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);

  const setCookie = (req: Request, res: Response, value: string, maxAge: number) =>
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`
    );

  return {
    required,
    issue,
    verify,
    checkPassword,

    middleware(req, res, next) {
      if (!required || !req.path.startsWith('/api/') || OPEN_PATHS.has(req.path) || verify(cookie(req))) {
        next();
        return;
      }
      res.status(401).json({ error: 'Sign in to use this glogg.', signIn: true });
    },

    routes(app) {
      app.get('/api/auth', (req, res) => {
        res.json({ required, authenticated: !required || verify(cookie(req)) });
      });

      app.post('/api/auth/login', (req, res) => {
        if (!required) {
          res.status(204).end();
          return;
        }
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const t = now();
        const entry = failures.get(ip);
        if (entry && entry.resetAt <= t) failures.delete(ip);
        const current = failures.get(ip);
        if (current && current.count >= MAX_FAILURES) {
          const minutes = Math.ceil((current.resetAt - t) / 60_000);
          res.setHeader('Retry-After', String(Math.ceil((current.resetAt - t) / 1000)));
          res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
          return;
        }
        if (!checkPassword(req.body?.password)) {
          // Many addresses could fill the table: drop expired entries, and start over if that isn't enough.
          if (failures.size > 10_000) {
            for (const [k, v] of failures) if (v.resetAt <= t) failures.delete(k);
            if (failures.size > 10_000) failures.clear();
          }
          failures.set(ip, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? t + FAILURE_WINDOW_MS });
          res.status(401).json({ error: 'Wrong password.' });
          return;
        }
        failures.delete(ip);
        setCookie(req, res, issue(t), SESSION_SECONDS);
        res.status(204).end();
      });

      app.post('/api/auth/logout', (req, res) => {
        setCookie(req, res, '', 0);
        res.status(204).end();
      });
    },
  };
}

/**
 * Which proxies to believe about the client's address and protocol. By default
 * only private-network ones (Traefik in Docker, a LAN reverse proxy), so a
 * visitor on the internet can't fake X-Forwarded-For to dodge the rate limit.
 */
export function trustProxySetting(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return 'loopback, linklocal, uniquelocal';
  if (value === 'true' || value === 'false') return value === 'true';
  return /^\d+$/.test(value) ? Number(value) : value;
}
