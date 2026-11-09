import dns from 'node:dns/promises';
import tls from 'node:tls';
import * as cheerio from 'cheerio';
import { definePlugin, fail, mapLimit, str, toHostname, toUrl } from '../../server/plugins/sdk.js';
import type { OutputBlock, PluginContext } from '../../server/plugins/sdk.js';

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────
export interface HeaderCheck {
  label: string;
  pass: boolean | null;
  detail: string;
  weight: number;
}

export function gradeSecurityHeaders(h: Record<string, string>, isHttps = true): { grade: string; score: number; checks: HeaderCheck[] } {
  const get = (k: string) => h[k.toLowerCase()];
  const csp = get('content-security-policy');
  const hsts = get('strict-transport-security');
  const maxAge = Number(hsts?.match(/max-age=(\d+)/i)?.[1] || 0);
  const checks: HeaderCheck[] = [
    { label: 'HTTPS', pass: isHttps, detail: isHttps ? 'Served over TLS' : 'Plain HTTP', weight: 25 },
    { label: 'Strict-Transport-Security', pass: maxAge >= 15_552_000, detail: hsts ? `max-age=${maxAge}${/includesubdomains/i.test(hsts) ? ', includeSubDomains' : ''}` : 'missing', weight: 15 },
    { label: 'Content-Security-Policy', pass: Boolean(csp) && !/unsafe-inline/.test(csp || '') ? true : csp ? null : false, detail: csp ? (/unsafe-inline/.test(csp) ? "present, allows 'unsafe-inline'" : 'present') : 'missing', weight: 20 },
    { label: 'X-Content-Type-Options', pass: get('x-content-type-options')?.toLowerCase() === 'nosniff', detail: get('x-content-type-options') || 'missing', weight: 10 },
    { label: 'Clickjacking protection', pass: Boolean(get('x-frame-options') || /frame-ancestors/.test(csp || '')), detail: get('x-frame-options') || (/frame-ancestors/.test(csp || '') ? 'CSP frame-ancestors' : 'missing'), weight: 10 },
    { label: 'Referrer-Policy', pass: Boolean(get('referrer-policy')), detail: get('referrer-policy') || 'missing', weight: 8 },
    { label: 'Permissions-Policy', pass: Boolean(get('permissions-policy')), detail: get('permissions-policy') ? 'present' : 'missing', weight: 6 },
    { label: 'Cross-Origin-Opener-Policy', pass: Boolean(get('cross-origin-opener-policy')), detail: get('cross-origin-opener-policy') || 'missing', weight: 3 },
    { label: 'No version disclosure', pass: !/\d/.test(`${get('server') || ''}${get('x-powered-by') || ''}`), detail: [get('server'), get('x-powered-by')].filter(Boolean).join(' · ') || 'hidden', weight: 3 },
  ];
  const total = checks.reduce((s, c) => s + c.weight, 0);
  const got = checks.reduce((s, c) => s + (c.pass === true ? c.weight : c.pass === null ? c.weight / 2 : 0), 0);
  const score = Math.round((got / total) * 100);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : score >= 30 ? 'E' : 'F';
  return { grade, score, checks };
}

const TECH_RULES: [string, (ctx: { html: string; headers: Record<string, string>; cookies: string }) => boolean][] = [
  ['Cloudflare', ({ headers }) => Boolean(headers['cf-ray']) || /cloudflare/i.test(headers.server || '')],
  ['Fastly', ({ headers }) => /fastly/i.test(headers['x-served-by'] || '') || Boolean(headers['x-fastly-request-id'])],
  ['Vercel', ({ headers }) => Boolean(headers['x-vercel-id'])],
  ['Netlify', ({ headers }) => Boolean(headers['x-nf-request-id'])],
  ['nginx', ({ headers }) => /nginx/i.test(headers.server || '')],
  ['Apache', ({ headers }) => /apache/i.test(headers.server || '')],
  ['PHP', ({ headers, cookies }) => /php/i.test(headers['x-powered-by'] || '') || /PHPSESSID/.test(cookies)],
  ['Express', ({ headers }) => /express/i.test(headers['x-powered-by'] || '')],
  ['WordPress', ({ html }) => /wp-content|wp-includes/.test(html)],
  ['Shopify', ({ html, headers }) => /cdn\.shopify\.com/.test(html) || Boolean(headers['x-shopid'])],
  ['Ghost', ({ html }) => /content="Ghost/.test(html)],
  ['Next.js', ({ html, headers }) => /__NEXT_DATA__|_next\/static/.test(html) || /next\.js/i.test(headers['x-powered-by'] || '')],
  ['Nuxt', ({ html }) => /__NUXT__|_nuxt\//.test(html)],
  ['Astro', ({ html }) => /astro-island|content="Astro/.test(html)],
  ['React', ({ html }) => /data-reactroot|react-dom/.test(html)],
  ['Vue', ({ html }) => /data-v-[0-9a-f]{6}|vue(\.min)?\.js/.test(html)],
  ['Svelte', ({ html }) => /svelte-[a-z0-9]{5,}/.test(html)],
  ['jQuery', ({ html }) => /jquery[.-]/i.test(html)],
  ['Bootstrap', ({ html }) => /bootstrap(\.min)?\.(css|js)/.test(html)],
  ['Tailwind', ({ html }) => /class="[^"]*\b(?:flex|grid) [^"]*\b(?:px|py|mx|my)-\d/.test(html)],
  ['Google Analytics', ({ html }) => /googletagmanager\.com\/gtag|google-analytics\.com/.test(html)],
  ['Google Tag Manager', ({ html }) => /googletagmanager\.com\/gtm\.js/.test(html)],
  ['Plausible', ({ html }) => /plausible\.io\/js/.test(html)],
  ['Matomo', ({ html }) => /matomo\.js|piwik\.js/.test(html)],
  ['Meta Pixel', ({ html }) => /connect\.facebook\.net\/.*fbevents/.test(html)],
  ['Hotjar', ({ html }) => /static\.hotjar\.com/.test(html)],
  ['reCAPTCHA', ({ html }) => /recaptcha/.test(html)],
  ['hCaptcha', ({ html }) => /hcaptcha\.com/.test(html)],
];

export function fingerprintTech(html: string, headers: Record<string, string>): string[] {
  const cookies = headers['set-cookie'] || '';
  const found = TECH_RULES.filter(([, test]) => test({ html, headers, cookies })).map(([n]) => n);
  const gen = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i)?.[1];
  if (gen && !found.some((f) => gen.toLowerCase().includes(f.toLowerCase()))) found.unshift(gen);
  return found;
}

// ── Fetch with manual redirect chain + timing ───────────────────────────────
async function fetchChain(ctx: PluginContext, start: string) {
  const chain: { url: string; status: number; ms: number }[] = [];
  let url = start;
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    const res = await ctx.fetch(url, { redirect: 'manual', headers: { Accept: 'text/html,*/*' } }, 15_000);
    chain.push({ url, status: res.status, ms: Math.round(performance.now() - t) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      await res.body?.cancel();
      continue;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const setCookie = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() || [];
    if (setCookie.length) headers['set-cookie'] = setCookie.join('\n');
    const body = await res.text();
    return { chain, final: url, status: res.status, headers, body, setCookie };
  }
  return fail('More than 10 redirects');
}

const ms = (n: number) => `${n} ms`;

export default definePlugin({
  id: 'webtest',
  name: 'Website testing',
  description: 'Security headers, TLS, performance (PageSpeed), SEO, broken links, tech stack, email security and latency.',
  category: 'webtest',
  icon: 'Gauge',
  settings: [{ key: 'psiKey', label: 'PageSpeed API key (optional)', secret: true, help: 'Raises Google PageSpeed rate limits.' }],
  tools: [
    {
      id: 'headers',
      name: 'Security headers',
      description: 'Grade A–F, redirect chain, cookies and server disclosure.',
      trigger: 'headers',
      inputs: [{ key: 'url', label: 'URL', required: true, placeholder: 'example.com' }],
      async run(input, ctx) {
        const r = await fetchChain(ctx, toUrl(str(input, 'url')));
        const g = gradeSecurityHeaders(r.headers, r.final.startsWith('https:'));
        const cookieChecks = r.setCookie.map((c) => {
          const name = c.split('=')[0];
          const ok = /;\s*secure/i.test(c) && /;\s*httponly/i.test(c) && /;\s*samesite/i.test(c);
          return { label: `Cookie ${name}`, pass: ok, detail: ['Secure', 'HttpOnly', 'SameSite'].filter((f) => !new RegExp(`;\\s*${f}`, 'i').test(c)).map((f) => `no ${f}`).join(', ') || 'Secure, HttpOnly, SameSite' };
        });
        return {
          summary: `Grade ${g.grade} (${g.score}/100)`,
          blocks: [
            { type: 'stat', items: [
              { label: 'Grade', value: g.grade, tone: g.score >= 75 ? 'ok' : g.score >= 45 ? 'warn' : 'bad' },
              { label: 'Score', value: `${g.score}/100` },
              { label: 'Status', value: String(r.status), tone: r.status < 400 ? 'ok' : 'bad' },
              { label: 'Redirects', value: String(r.chain.length - 1) },
            ] },
            { type: 'checks', title: 'Headers', items: [...g.checks.map(({ label, pass, detail }) => ({ label, pass, detail })), ...cookieChecks] },
            { type: 'table', title: 'Redirect chain', columns: ['Status', 'URL', 'Time'], rows: r.chain.map((c) => [c.status, c.url, ms(c.ms)]) },
            { type: 'code', title: 'Raw response headers', content: Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n') },
          ],
        };
      },
    },
    {
      id: 'tls',
      name: 'TLS certificate',
      description: 'Issuer, validity, SANs, protocol and cipher.',
      trigger: 'tls',
      inputs: [{ key: 'host', label: 'Host', required: true }],
      async run(input) {
        const host = toHostname(str(input, 'host'));
        const info = await new Promise<{ cert: tls.PeerCertificate; protocol: string | null; cipher: tls.CipherNameAndProtocol; authorized: boolean; authError?: string }>((resolve, reject) => {
          const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10_000 }, () => {
            resolve({ cert: sock.getPeerCertificate(), protocol: sock.getProtocol(), cipher: sock.getCipher(), authorized: sock.authorized, authError: sock.authorizationError?.toString() });
            sock.end();
          });
          sock.on('error', reject);
          sock.on('timeout', () => { sock.destroy(); reject(new Error('TLS handshake timed out')); });
        });
        const c = info.cert;
        if (!c || !c.valid_to) fail('No certificate returned');
        const daysLeft = Math.round((Date.parse(c.valid_to) - Date.now()) / 86_400_000);
        const sans = (c.subjectaltname || '').split(', ').map((s) => s.replace(/^DNS:/, '')).filter(Boolean);
        const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || '—';
        return {
          summary: `${info.authorized ? 'Valid' : 'Invalid'} · ${daysLeft}d left`,
          blocks: [
            { type: 'stat', items: [
              { label: 'Trust', value: info.authorized ? 'Valid' : 'Untrusted', tone: info.authorized ? 'ok' : 'bad' },
              { label: 'Expires in', value: `${daysLeft} days`, tone: daysLeft < 14 ? 'bad' : daysLeft < 30 ? 'warn' : 'ok' },
              { label: 'Protocol', value: info.protocol || '—', tone: info.protocol === 'TLSv1.3' ? 'ok' : 'warn' },
            ] },
            { type: 'kv', items: [
              { label: 'Subject', value: first(c.subject?.CN) },
              { label: 'Issuer', value: `${first(c.issuer?.O)} (${first(c.issuer?.CN)})` },
              { label: 'Valid from', value: new Date(c.valid_from).toISOString().slice(0, 10) },
              { label: 'Valid to', value: new Date(c.valid_to).toISOString().slice(0, 10) },
              { label: 'Cipher', value: info.cipher?.name || '—' },
              { label: 'SHA-256', value: c.fingerprint256 || '—' },
              ...(info.authError ? [{ label: 'Error', value: info.authError, tone: 'bad' as const }] : []),
            ] },
            { type: 'list', title: `SANs (${sans.length})`, items: sans.slice(0, 100).map((s) => ({ title: s })) },
          ],
        };
      },
    },
    {
      id: 'pagespeed',
      name: 'PageSpeed',
      description: 'Lighthouse scores and Core Web Vitals via Google PageSpeed Insights.',
      trigger: 'speed',
      inputs: [
        { key: 'url', label: 'URL', required: true },
        { key: 'strategy', label: 'Device', type: 'select', default: 'mobile', options: [{ value: 'mobile', label: 'Mobile' }, { value: 'desktop', label: 'Desktop' }] },
      ],
      async run(input, ctx) {
        const params = new URLSearchParams({ url: toUrl(str(input, 'url')), strategy: str(input, 'strategy', 'mobile') });
        for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) params.append('category', c);
        if (ctx.settings.psiKey) params.set('key', ctx.settings.psiKey);
        const r = await ctx.fetchJson<{
          lighthouseResult: {
            categories: Record<string, { title: string; score: number }>;
            audits: Record<string, { title: string; displayValue?: string; score: number | null; details?: { overallSavingsMs?: number } }>;
          };
        }>(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`, {}, 90_000);
        const cats = r.lighthouseResult.categories;
        const a = r.lighthouseResult.audits;
        const tone = (s: number) => (s >= 0.9 ? 'ok' : s >= 0.5 ? 'warn' : 'bad') as 'ok' | 'warn' | 'bad';
        const vitals = ['largest-contentful-paint', 'cumulative-layout-shift', 'total-blocking-time', 'first-contentful-paint', 'speed-index', 'interactive'];
        const opps = Object.values(a)
          .filter((x) => (x.details?.overallSavingsMs || 0) > 100)
          .sort((x, y) => (y.details!.overallSavingsMs || 0) - (x.details!.overallSavingsMs || 0))
          .slice(0, 8);
        return {
          summary: `Performance ${Math.round(cats.performance.score * 100)}`,
          blocks: [
            { type: 'stat', items: Object.values(cats).map((c) => ({ label: c.title, value: String(Math.round(c.score * 100)), tone: tone(c.score) })) },
            { type: 'kv', title: 'Metrics', items: vitals.filter((v) => a[v]).map((v) => ({ label: a[v].title, value: a[v].displayValue || '—', tone: a[v].score === null ? undefined : tone(a[v].score!) })) },
            { type: 'list', title: 'Biggest wins', items: opps.map((o) => ({ title: o.title, subtitle: `≈ ${Math.round(o.details!.overallSavingsMs!)} ms`, tone: 'warn' as const })) },
          ],
        };
      },
    },
    {
      id: 'seo',
      name: 'SEO & meta',
      description: 'Title, description, canonical, Open Graph, headings, robots and sitemap.',
      trigger: 'seo',
      inputs: [{ key: 'url', label: 'URL', required: true }],
      async run(input, ctx) {
        const r = await fetchChain(ctx, toUrl(str(input, 'url')));
        const $ = cheerio.load(r.body);
        const origin = new URL(r.final).origin;
        const [robots, sitemap] = await Promise.all([
          ctx.fetch(`${origin}/robots.txt`, {}, 8000).then(async (x) => (x.ok ? x.text() : '')).catch(() => ''),
          ctx.fetch(`${origin}/sitemap.xml`, { method: 'HEAD' }, 8000).then((x) => x.ok).catch(() => false),
        ]);
        const title = $('title').first().text().trim();
        const desc = $('meta[name="description"]').attr('content')?.trim() || '';
        const h1 = $('h1').length;
        const imgs = $('img').toArray();
        const noAlt = imgs.filter((i) => !$(i).attr('alt')).length;
        const words = $('body').text().split(/\s+/).filter(Boolean).length;
        const og = (p: string) => $(`meta[property="og:${p}"]`).attr('content');
        const robotsMeta = $('meta[name="robots"]').attr('content') || '';
        return {
          summary: title,
          blocks: [
            { type: 'checks', items: [
              { label: 'Title', pass: title.length >= 10 && title.length <= 65, detail: `${title.length} chars — ${title || 'missing'}` },
              { label: 'Meta description', pass: desc.length >= 50 && desc.length <= 160, detail: `${desc.length} chars${desc ? ` — ${desc.slice(0, 90)}` : ' — missing'}` },
              { label: 'Single H1', pass: h1 === 1, detail: `${h1} found` },
              { label: 'Canonical', pass: Boolean($('link[rel="canonical"]').attr('href')), detail: $('link[rel="canonical"]').attr('href') || 'missing' },
              { label: 'lang attribute', pass: Boolean($('html').attr('lang')), detail: $('html').attr('lang') || 'missing' },
              { label: 'Viewport', pass: Boolean($('meta[name="viewport"]').length), detail: $('meta[name="viewport"]').attr('content') || 'missing' },
              { label: 'Open Graph', pass: Boolean(og('title') && og('image')), detail: [og('title') && 'title', og('description') && 'description', og('image') && 'image'].filter(Boolean).join(', ') || 'missing' },
              { label: 'Indexable', pass: !/noindex/i.test(robotsMeta) && !/noindex/i.test(r.headers['x-robots-tag'] || ''), detail: robotsMeta || r.headers['x-robots-tag'] || 'no robots restrictions' },
              { label: 'Image alt text', pass: noAlt === 0, detail: `${noAlt} of ${imgs.length} images missing alt` },
              { label: 'robots.txt', pass: Boolean(robots), detail: robots ? `${robots.split('\n').length} lines` : 'missing' },
              { label: 'sitemap.xml', pass: sitemap || /sitemap:/i.test(robots), detail: sitemap ? 'found' : /sitemap:/i.test(robots) ? 'declared in robots.txt' : 'missing' },
            ] },
            { type: 'kv', items: [{ label: 'Final URL', value: r.final }, { label: 'Words', value: String(words) }, { label: 'Links', value: String($('a[href]').length) }] },
          ],
        };
      },
    },
    {
      id: 'links',
      name: 'Broken links',
      description: 'Checks up to 80 links on a page.',
      trigger: 'links',
      inputs: [{ key: 'url', label: 'URL', required: true }],
      async run(input, ctx) {
        const r = await fetchChain(ctx, toUrl(str(input, 'url')));
        const $ = cheerio.load(r.body);
        const links = [...new Set($('a[href]').toArray().map((a) => {
          try { return new URL($(a).attr('href')!, r.final).toString().split('#')[0]; } catch { return ''; }
        }))].filter((l) => /^https?:/.test(l)).slice(0, 80);
        const results = await mapLimit(links, 8, async (l) => {
          try {
            let res = await ctx.fetch(l, { method: 'HEAD', redirect: 'follow' }, 10_000);
            if (res.status === 405 || res.status === 403) res = await ctx.fetch(l, { redirect: 'follow' }, 10_000);
            return { l, status: res.status };
          } catch {
            return { l, status: 0 };
          }
        });
        const broken = results.filter((x) => x.status === 0 || x.status >= 400);
        return {
          summary: `${broken.length} broken of ${results.length}`,
          blocks: [
            { type: 'stat', items: [{ label: 'Checked', value: String(results.length) }, { label: 'Broken', value: String(broken.length), tone: broken.length ? 'bad' : 'ok' }] },
            { type: 'table', title: 'Problems', columns: ['Status', 'URL'], rows: broken.map((b) => [b.status || 'error', b.l]) },
          ],
        };
      },
    },
    {
      id: 'tech',
      name: 'Tech stack',
      description: 'Frameworks, CDN, analytics and trackers.',
      trigger: 'tech',
      inputs: [{ key: 'url', label: 'URL', required: true }],
      async run(input, ctx) {
        const r = await fetchChain(ctx, toUrl(str(input, 'url')));
        const tech = fingerprintTech(r.body, r.headers);
        const trackers = tech.filter((t) => /Analytics|Tag Manager|Pixel|Hotjar|Matomo|Plausible/.test(t));
        return {
          summary: tech.join(', ') || 'Nothing detected',
          blocks: [
            { type: 'stat', items: [{ label: 'Detected', value: String(tech.length) }, { label: 'Trackers', value: String(trackers.length), tone: trackers.length ? 'warn' : 'ok' }] },
            { type: 'list', items: tech.map((t) => ({ title: t, tone: trackers.includes(t) ? ('warn' as const) : undefined })) },
            { type: 'actions', items: [{ label: 'BuiltWith', href: `https://builtwith.com/${new URL(r.final).hostname}` }, { label: 'Wappalyzer', href: `https://www.wappalyzer.com/lookup/${new URL(r.final).hostname}` }] },
          ],
        };
      },
    },
    {
      id: 'email',
      name: 'Email security',
      description: 'MX, SPF, DMARC and common DKIM selectors.',
      trigger: 'mail',
      inputs: [{ key: 'domain', label: 'Domain', required: true }],
      async run(input) {
        const d = toHostname(str(input, 'domain'));
        const txt = async (h: string) => (await dns.resolveTxt(h).catch(() => [] as string[][])).map((t) => t.join(''));
        const [mx, root, dmarc, ...dkim] = await Promise.all([
          dns.resolveMx(d).catch(() => []),
          txt(d),
          txt(`_dmarc.${d}`),
          ...['default', 'google', 'selector1', 'selector2', 'k1', 'mail', 's1', 'dkim'].map(async (s) => ({ s, rec: (await txt(`${s}._domainkey.${d}`)).find((r) => /v=DKIM1|p=/.test(r)) })),
        ]);
        const spf = root.find((r) => r.startsWith('v=spf1'));
        const dm = dmarc.find((r) => r.startsWith('v=DMARC1'));
        const policy = dm?.match(/p=(\w+)/)?.[1];
        const dkimFound = (dkim as { s: string; rec?: string }[]).filter((x) => x.rec);
        const checks: OutputBlock = {
          type: 'checks',
          items: [
            { label: 'MX', pass: mx.length > 0, detail: mx.map((m) => m.exchange).join(', ') || 'none' },
            { label: 'SPF', pass: spf ? !/\+all/.test(spf) : false, detail: spf || 'missing' },
            { label: 'SPF strictness', pass: spf ? /-all/.test(spf) : null, detail: spf ? (/-all/.test(spf) ? 'hard fail (-all)' : /~all/.test(spf) ? 'soft fail (~all)' : 'permissive') : '—' },
            { label: 'DMARC', pass: policy ? policy !== 'none' : false, detail: dm || 'missing' },
            { label: 'DKIM (common selectors)', pass: dkimFound.length ? true : null, detail: dkimFound.map((x) => x.s).join(', ') || 'none found (custom selector?)' },
          ],
        };
        return { summary: `SPF ${spf ? '✓' : '✗'} · DMARC ${policy || '✗'}`, blocks: [checks] };
      },
    },
    {
      id: 'latency',
      name: 'Response time',
      description: 'Five sequential requests: min, median and max.',
      trigger: 'ping',
      inputs: [{ key: 'url', label: 'URL', required: true }],
      async run(input, ctx) {
        const url = toUrl(str(input, 'url'));
        const times: number[] = [];
        let status = 0;
        for (let i = 0; i < 5; i++) {
          const t = performance.now();
          const res = await ctx.fetch(url, { headers: { 'Cache-Control': 'no-cache' } }, 15_000);
          await res.arrayBuffer();
          status = res.status;
          times.push(Math.round(performance.now() - t));
        }
        const sorted = [...times].sort((a, b) => a - b);
        const med = sorted[2];
        return {
          summary: `median ${med} ms`,
          blocks: [
            { type: 'stat', items: [
              { label: 'Median', value: ms(med), tone: med < 300 ? 'ok' : med < 1000 ? 'warn' : 'bad' },
              { label: 'Min', value: ms(sorted[0]) },
              { label: 'Max', value: ms(sorted[4]) },
              { label: 'Status', value: String(status) },
            ] },
            { type: 'table', columns: ['Run', 'Time'], rows: times.map((t, i) => [i + 1, ms(t)]) },
          ],
        };
      },
    },
  ],
});
