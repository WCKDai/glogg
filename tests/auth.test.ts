/**
 * Password protection: session tokens, configuration, and the sign-in flow
 * over HTTP (cookies, rate limits, what a locked server still answers).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawRequest, startGloggServer, useTempGloggHome } from './helpers.js';

const home = useTempGloggHome();
const { configuredPassword, createAuth, sessionSecret, trustProxySetting } = await import('../server/auth.js');
const PASSWORD = 'correct horse battery staple';

describe('sessions', () => {
  const secret = Buffer.alloc(32, 7);
  const now = 1_800_000_000_000;
  const auth = createAuth({ password: PASSWORD, secret, now: () => now });

  it('issues tokens that hold for 30 days', () => {
    const token = auth.issue();
    expect(auth.verify(token)).toBe(true);
    expect(auth.verify(token, now + 29 * 86_400_000)).toBe(true);
    expect(auth.verify(token, now + 31 * 86_400_000)).toBe(false);
  });

  it('rejects tampered tokens, and tokens from another secret or an old password', () => {
    const token = auth.issue();
    const [expires, mac] = token.split('.');
    expect(auth.verify(`${Number(expires) + 86_400}.${mac}`)).toBe(false);
    expect(auth.verify(`${expires}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
    expect(auth.verify('')).toBe(false);
    expect(auth.verify(undefined)).toBe(false);
    expect(createAuth({ password: PASSWORD, secret: Buffer.alloc(32, 8), now: () => now }).verify(token)).toBe(false);
    expect(createAuth({ password: 'a different password', secret, now: () => now }).verify(token)).toBe(false);
  });

  it('checks the password exactly', () => {
    expect(auth.checkPassword(PASSWORD)).toBe(true);
    expect(auth.checkPassword(PASSWORD.slice(0, -1))).toBe(false);
    expect(auth.checkPassword(`${PASSWORD} `)).toBe(false);
    expect(auth.checkPassword(undefined)).toBe(false);
    expect(auth.checkPassword({ toString: () => PASSWORD })).toBe(false);
  });

  it('is off without a password', () => {
    expect(createAuth({ password: '', secret }).required).toBe(false);
  });
});

describe('configuration', () => {
  it('takes the password from the environment or a file, and refuses to start open on a bad file', () => {
    expect(configuredPassword({})).toBe('');
    expect(configuredPassword({ GLOGG_PASSWORD: 'pw' })).toBe('pw');
    const file = path.join(home, 'password.txt');
    fs.writeFileSync(file, 'from-a-file\n');
    expect(configuredPassword({ GLOGG_PASSWORD_FILE: file })).toBe('from-a-file');
    expect(() => configuredPassword({ GLOGG_PASSWORD_FILE: `${file}.missing` })).toThrow(/can't be read/);
    fs.writeFileSync(file, '  \n');
    expect(() => configuredPassword({ GLOGG_PASSWORD_FILE: file })).toThrow(/is empty/);
  });

  it('keeps one session secret per home, readable only by its owner', () => {
    const dir = path.join(home, 'secret-home');
    const secret = sessionSecret(dir);
    expect(secret).toHaveLength(32);
    expect(sessionSecret(dir).equals(secret)).toBe(true);
    expect(fs.statSync(path.join(dir, 'session.key')).mode & 0o777).toBe(0o600);
  });

  it.each([
    [undefined, 'loopback, linklocal, uniquelocal'],
    ['1', 1],
    ['false', false],
    ['10.0.0.0/8', '10.0.0.0/8'],
  ])('trusts proxies: GLOGG_TRUST_PROXY=%s → %s', (value, setting) => {
    expect(trustProxySetting(value)).toEqual(setting);
  });
});

describe('a password-protected server', () => {
  let server: Awaited<ReturnType<typeof startGloggServer>>;
  beforeAll(async () => {
    process.env.GLOGG_PASSWORD = PASSWORD;
    server = await startGloggServer();
  });
  afterAll(async () => {
    delete process.env.GLOGG_PASSWORD;
    await server.close();
  });

  const request = (p: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    rawRequest(server.port, { path: p, ...opts, headers: { Host: `127.0.0.1:${server.port}`, ...opts.headers } });
  const signIn = (password: string, headers: Record<string, string> = {}) =>
    request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }), headers: { 'Content-Type': 'application/json', ...headers } });

  it('answers health and the sign-in check without a session, and nothing else', async () => {
    expect((await request('/api/health')).status).toBe(200);
    expect(JSON.parse((await request('/api/auth')).body)).toEqual({ required: true, authenticated: false });
    const locked = await request('/api/plugins');
    expect(locked.status).toBe(401);
    expect(JSON.parse(locked.body)).toMatchObject({ signIn: true });
    // Routes that are public on an open glogg are not on a protected one.
    const search = await request('/api/search', { method: 'POST', body: '{"query":"x"}', headers: { 'Content-Type': 'application/json' } });
    expect(search.status).toBe(401);
  });

  it('signs in with the password, lets the session through, and signs out', async () => {
    expect((await signIn('wrong')).status).toBe(401);
    const ok = await signIn(PASSWORD);
    expect(ok.status).toBe(204);
    const setCookie = String(ok.headers['set-cookie']);
    // No Secure flag over plain HTTP, or the browser would drop the cookie.
    expect(setCookie).toMatch(/^glogg_session=\d+\.[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    const cookie = setCookie.split(';')[0];
    expect((await request('/api/plugins', { headers: { Cookie: cookie } })).status).toBe(200);
    expect(JSON.parse((await request('/api/auth', { headers: { Cookie: cookie } })).body)).toEqual({ required: true, authenticated: true });
    const out = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    expect(String(out.headers['set-cookie'])).toMatch(/^glogg_session=; .*Max-Age=0/);
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const ok = await signIn(PASSWORD, { 'X-Forwarded-Proto': 'https' });
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict; .*; Secure$/);
  });

  it('stops guessing after ten wrong passwords from one address, without locking out others', async () => {
    const attacker = { 'X-Forwarded-For': '203.0.113.9' };
    for (let i = 0; i < 10; i++) expect((await signIn('guess', attacker)).status).toBe(401);
    const blocked = await signIn(PASSWORD, attacker);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await signIn(PASSWORD, { 'X-Forwarded-For': '203.0.113.10' })).status).toBe(204);
  });
});
