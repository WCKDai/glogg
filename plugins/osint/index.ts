import dns from 'node:dns/promises';
import net from 'node:net';
import { definePlugin, fail, mapLimit, str, toHostname, toUrl } from '../../server/plugins/sdk.js';
import type { OutputBlock, PluginContext } from '../../server/plugins/sdk.js';

// ── Username footprint ──────────────────────────────────────────────────────
// Only sites with an API or reliable 404 semantics, so results are not guesses.
interface Site {
  name: string;
  profile: (u: string) => string;
  probe?: (u: string) => string;
  exists: (status: number, body: string) => boolean | null;
}

const by404 = (status: number) => (status === 200 ? true : status === 404 || status === 410 ? false : null);

export const USERNAME_SITES: Site[] = [
  { name: 'GitHub', profile: (u) => `https://github.com/${u}`, probe: (u) => `https://api.github.com/users/${u}`, exists: by404 },
  { name: 'GitLab', profile: (u) => `https://gitlab.com/${u}`, probe: (u) => `https://gitlab.com/api/v4/users?username=${u}`, exists: (s, b) => (s === 200 ? b.trim() !== '[]' : null) },
  { name: 'Codeberg', profile: (u) => `https://codeberg.org/${u}`, probe: (u) => `https://codeberg.org/api/v1/users/${u}`, exists: by404 },
  { name: 'Reddit', profile: (u) => `https://www.reddit.com/user/${u}`, probe: (u) => `https://www.reddit.com/user/${u}/about.json`, exists: (s, b) => (s === 200 ? !b.includes('"is_suspended": true') : s === 404 ? false : null) },
  { name: 'Hacker News', profile: (u) => `https://news.ycombinator.com/user?id=${u}`, probe: (u) => `https://hacker-news.firebaseio.com/v0/user/${u}.json`, exists: (s, b) => (s === 200 ? b.trim() !== 'null' : null) },
  { name: 'Lobsters', profile: (u) => `https://lobste.rs/~${u}`, exists: by404 },
  { name: 'Keybase', profile: (u) => `https://keybase.io/${u}`, probe: (u) => `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${u}`, exists: (s, b) => (s === 200 ? !b.includes('"them":[null]') : null) },
  { name: 'Dev.to', profile: (u) => `https://dev.to/${u}`, probe: (u) => `https://dev.to/api/users/by_username?url=${u}`, exists: by404 },
  { name: 'Mastodon.social', profile: (u) => `https://mastodon.social/@${u}`, probe: (u) => `https://mastodon.social/api/v1/accounts/lookup?acct=${u}`, exists: by404 },
  { name: 'Bluesky', profile: (u) => `https://bsky.app/profile/${u}.bsky.social`, probe: (u) => `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${u}.bsky.social`, exists: (s) => (s === 200 ? true : s === 400 ? false : null) },
  { name: 'Docker Hub', profile: (u) => `https://hub.docker.com/u/${u}`, probe: (u) => `https://hub.docker.com/v2/users/${u}/`, exists: by404 },
  { name: 'npm', profile: (u) => `https://www.npmjs.com/~${u}`, probe: (u) => `https://registry.npmjs.org/-/user/org.couchdb.user:${u}`, exists: by404 },
  { name: 'PyPI', profile: (u) => `https://pypi.org/user/${u}/`, exists: by404 },
  { name: 'Lichess', profile: (u) => `https://lichess.org/@/${u}`, probe: (u) => `https://lichess.org/api/user/${u}`, exists: by404 },
  { name: 'Chess.com', profile: (u) => `https://www.chess.com/member/${u}`, probe: (u) => `https://api.chess.com/pub/player/${u.toLowerCase()}`, exists: by404 },
  { name: 'Telegram', profile: (u) => `https://t.me/${u}`, exists: (s, b) => (s === 200 ? b.includes('tgme_page_title') : null) },
  { name: 'Steam', profile: (u) => `https://steamcommunity.com/id/${u}`, exists: (s, b) => (s === 200 ? !b.includes('The specified profile could not be found') : null) },
  { name: 'Pastebin', profile: (u) => `https://pastebin.com/u/${u}`, exists: by404 },
  { name: 'Gravatar', profile: (u) => `https://gravatar.com/${u}`, probe: (u) => `https://en.gravatar.com/${u}.json`, exists: by404 },
  { name: 'SoundCloud', profile: (u) => `https://soundcloud.com/${u}`, exists: by404 },
  { name: 'Replit', profile: (u) => `https://replit.com/@${u}`, exists: by404 },
  { name: 'Hugging Face', profile: (u) => `https://huggingface.co/${u}`, probe: (u) => `https://huggingface.co/api/users/${u}/overview`, exists: by404 },
];

const isIp = (s: string) => net.isIP(s) !== 0;

async function resolveIp(host: string): Promise<string> {
  if (isIp(host)) return host;
  const [a] = await dns.resolve4(host).catch(() => [] as string[]);
  if (a) return a;
  const [aaaa] = await dns.resolve6(host).catch(() => [] as string[]);
  if (!aaaa) fail(`Couldn't resolve ${host}`);
  return aaaa;
}

function pivots(host: string): OutputBlock {
  const q = encodeURIComponent(host);
  return {
    type: 'actions',
    items: [
      { label: 'urlscan', href: `https://urlscan.io/search/#domain:${q}` },
      { label: 'VirusTotal', href: `https://www.virustotal.com/gui/domain/${q}` },
      { label: 'Shodan', href: `https://www.shodan.io/search?query=hostname:${q}` },
      { label: 'Censys', href: `https://search.censys.io/search?resource=hosts&q=${q}` },
      { label: 'SecurityTrails', href: `https://securitytrails.com/domain/${q}/dns` },
      { label: 'DNSDumpster', href: `https://dnsdumpster.com/` },
      { label: 'BuiltWith', href: `https://builtwith.com/${q}` },
      { label: 'Wayback', href: `https://web.archive.org/web/*/${q}*` },
    ],
  };
}

async function rdap(ctx: PluginContext, target: string) {
  const kind = isIp(target) ? 'ip' : 'domain';
  const r = await ctx.fetchJson<{
    ldhName?: string;
    name?: string;
    handle?: string;
    status?: string[];
    events?: { eventAction: string; eventDate: string }[];
    nameservers?: { ldhName: string }[];
    entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[];
    startAddress?: string;
    endAddress?: string;
    country?: string;
  }>(`https://rdap.org/${kind}/${encodeURIComponent(target)}`, { headers: { Accept: 'application/rdap+json' } }, 15_000);
  const ev = (a: string) => r.events?.find((e) => e.eventAction === a)?.eventDate?.slice(0, 10);
  const vcardName = (role: string) =>
    r.entities?.find((e) => e.roles?.includes(role))?.vcardArray?.[1]?.find((f) => f[0] === 'fn')?.[3];
  return { r, ev, vcardName, kind };
}

export default definePlugin({
  id: 'osint',
  name: 'OSINT',
  description: 'DNS, WHOIS/RDAP, subdomains, IP intel, username footprint, Wayback history and pivot links. No keys needed.',
  category: 'osint',
  icon: 'Radar',
  tools: [
    {
      id: 'dns',
      name: 'DNS records',
      description: 'A, AAAA, CNAME, MX, NS, TXT, SOA and CAA.',
      trigger: 'dns',
      inputs: [{ key: 'domain', label: 'Domain', required: true, placeholder: 'example.com' }],
      async run(input) {
        const host = toHostname(str(input, 'domain'));
        const rows: string[][] = [];
        const add = (type: string, values: string[]) => values.forEach((v) => rows.push([type, v]));
        await Promise.all([
          dns.resolve4(host).then((v) => add('A', v)).catch(() => undefined),
          dns.resolve6(host).then((v) => add('AAAA', v)).catch(() => undefined),
          dns.resolveCname(host).then((v) => add('CNAME', v)).catch(() => undefined),
          dns.resolveMx(host).then((v) => add('MX', v.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`))).catch(() => undefined),
          dns.resolveNs(host).then((v) => add('NS', v)).catch(() => undefined),
          dns.resolveTxt(host).then((v) => add('TXT', v.map((t) => t.join('')))).catch(() => undefined),
          dns.resolveSoa(host).then((s) => add('SOA', [`${s.nsname} ${s.hostmaster} serial ${s.serial}`])).catch(() => undefined),
          dns.resolveCaa(host).then((v) => add('CAA', v.map((c) => `${c.critical} ${Object.entries(c).filter(([k]) => k !== 'critical').map(([k, val]) => `${k} ${val}`).join(' ')}`))).catch(() => undefined),
        ]);
        if (!rows.length) fail(`No DNS records found for ${host}`);
        const order = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];
        rows.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
        return { summary: `${rows.length} records`, blocks: [{ type: 'table', columns: ['Type', 'Value'], rows }, pivots(host)] };
      },
    },
    {
      id: 'whois',
      name: 'WHOIS / RDAP',
      description: 'Registrar, dates, status and nameservers — or network owner for an IP.',
      trigger: 'whois',
      inputs: [{ key: 'target', label: 'Domain or IP', required: true }],
      async run(input, ctx) {
        const raw = str(input, 'target');
        const target = isIp(raw) ? raw : toHostname(raw).split('.').slice(-2).join('.');
        const { r, ev, vcardName, kind } = await rdap(ctx, target);
        if (kind === 'ip') {
          return {
            blocks: [
              { type: 'kv', items: [
                { label: 'Network', value: r.name || '—' },
                { label: 'Range', value: `${r.startAddress} – ${r.endAddress}` },
                { label: 'Country', value: r.country || '—' },
                { label: 'Registrant', value: String(vcardName('registrant') || '—') },
                { label: 'Abuse', value: String(vcardName('abuse') || '—') },
              ] },
            ],
          };
        }
        const expires = ev('expiration');
        const daysLeft = expires ? Math.round((Date.parse(expires) - Date.now()) / 86_400_000) : undefined;
        return {
          summary: `${target} · ${vcardName('registrar') ?? 'unknown registrar'}`,
          blocks: [
            { type: 'kv', items: [
              { label: 'Domain', value: r.ldhName || target },
              { label: 'Registrar', value: String(vcardName('registrar') || '—') },
              { label: 'Registered', value: ev('registration') || '—' },
              { label: 'Updated', value: ev('last changed') || '—' },
              { label: 'Expires', value: expires ? `${expires} (${daysLeft}d)` : '—', tone: daysLeft !== undefined && daysLeft < 30 ? 'warn' : undefined },
              { label: 'Status', value: (r.status || []).join(', ') || '—' },
              { label: 'Nameservers', value: (r.nameservers || []).map((n) => n.ldhName.toLowerCase()).join(', ') || '—' },
            ] },
            pivots(target),
          ],
        };
      },
    },
    {
      id: 'subdomains',
      name: 'Subdomains',
      description: 'From certificate transparency logs (crt.sh).',
      trigger: 'subs',
      inputs: [{ key: 'domain', label: 'Domain', required: true }],
      async run(input, ctx) {
        const host = toHostname(str(input, 'domain'));
        const certs = await ctx.fetchJson<{ name_value: string; not_before: string }[]>(
          `https://crt.sh/?q=${encodeURIComponent(`%.${host}`)}&output=json`,
          {},
          40_000
        );
        const seen = new Map<string, string>();
        for (const c of certs) {
          for (const n of c.name_value.split('\n')) {
            const name = n.trim().toLowerCase().replace(/^\*\./, '');
            if (name.endsWith(host) && (!seen.has(name) || seen.get(name)! < c.not_before)) seen.set(name, c.not_before);
          }
        }
        const names = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        return {
          summary: `${names.length} subdomains`,
          blocks: [
            { type: 'stat', items: [{ label: 'Subdomains', value: String(names.length) }, { label: 'Certificates', value: String(certs.length) }] },
            { type: 'table', columns: ['Host', 'Last cert'], rows: names.slice(0, 500).map(([n, d]) => [n, d.slice(0, 10)]) },
          ],
        };
      },
    },
    {
      id: 'ip',
      name: 'IP intel',
      description: 'Geo, ASN, ISP and reverse DNS for an IP or host.',
      trigger: 'ip',
      inputs: [{ key: 'target', label: 'IP or host', required: true }],
      async run(input, ctx) {
        const raw = str(input, 'target');
        const ip = await resolveIp(isIp(raw) ? raw : toHostname(raw));
        const [info, ptr] = await Promise.all([
          ctx.fetchJson<{ success: boolean; message?: string; country?: string; region?: string; city?: string; connection?: { asn?: number; org?: string; isp?: string; domain?: string }; timezone?: { id?: string }; type?: string }>(`https://ipwho.is/${ip}`),
          dns.reverse(ip).catch(() => [] as string[]),
        ]);
        if (!info.success) fail(info.message || 'Lookup failed');
        return {
          summary: `${ip} · ${info.connection?.org ?? ''} · ${info.country ?? ''}`,
          blocks: [
            { type: 'kv', items: [
              { label: 'IP', value: ip },
              { label: 'Reverse DNS', value: ptr.join(', ') || '—' },
              { label: 'Location', value: [info.city, info.region, info.country].filter(Boolean).join(', ') },
              { label: 'ASN', value: info.connection?.asn ? `AS${info.connection.asn}` : '—', href: info.connection?.asn ? `https://bgp.he.net/AS${info.connection.asn}` : undefined },
              { label: 'Org', value: info.connection?.org || '—' },
              { label: 'ISP', value: info.connection?.isp || '—' },
              { label: 'Timezone', value: info.timezone?.id || '—' },
            ] },
            { type: 'actions', items: [
              { label: 'Shodan', href: `https://www.shodan.io/host/${ip}` },
              { label: 'AbuseIPDB', href: `https://www.abuseipdb.com/check/${ip}` },
              { label: 'GreyNoise', href: `https://viz.greynoise.io/ip/${ip}` },
              { label: 'RDAP', run: { tool: 'osint/whois', inputs: { target: ip } } },
            ] },
          ],
        };
      },
    },
    {
      id: 'username',
      name: 'Username footprint',
      description: `Checks ${USERNAME_SITES.length} sites with reliable APIs — no guesswork.`,
      trigger: 'user',
      inputs: [{ key: 'username', label: 'Username', required: true }],
      async run(input, ctx) {
        const u = str(input, 'username').replace(/^@/, '');
        if (!/^[\w.-]{1,40}$/.test(u)) fail('Usernames may contain letters, digits, dot, dash and underscore.');
        const results = await mapLimit(USERNAME_SITES, 8, async (site) => {
          try {
            const res = await ctx.fetch((site.probe || site.profile)(u), { redirect: 'follow' }, 8000);
            const body = res.status === 200 ? (await res.text()).slice(0, 20_000) : '';
            return { site, found: site.exists(res.status, body) };
          } catch {
            return { site, found: null };
          }
        });
        const found = results.filter((r) => r.found === true);
        return {
          summary: `${found.length} of ${results.length} sites`,
          blocks: [
            { type: 'stat', items: [{ label: 'Found', value: String(found.length), tone: found.length ? 'ok' : undefined }, { label: 'Checked', value: String(results.length) }, { label: 'Unknown', value: String(results.filter((r) => r.found === null).length) }] },
            { type: 'list', title: 'Found', items: found.map(({ site }) => ({ title: site.name, subtitle: site.profile(u), href: site.profile(u), tone: 'ok' as const })) },
            { type: 'checks', title: 'All sites', items: results.map(({ site, found: f }) => ({ label: site.name, pass: f, detail: f === null ? 'could not verify' : f ? 'exists' : 'not found' })) },
          ],
        };
      },
    },
    {
      id: 'wayback',
      name: 'Wayback history',
      description: 'Snapshot timeline from the Internet Archive.',
      trigger: 'wb',
      inputs: [{ key: 'url', label: 'URL or domain', required: true }],
      async run(input, ctx) {
        const url = toUrl(str(input, 'url'));
        const rows = await ctx.fetchJson<string[][]>(
          `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode&collapse=timestamp:6&limit=200`,
          {},
          30_000
        );
        const snaps = rows.slice(1);
        if (!snaps.length) return { blocks: [{ type: 'notice', tone: 'warn', content: 'No snapshots found.' }, { type: 'actions', items: [{ label: 'Save now', href: `https://web.archive.org/save/${url}` }] }] };
        const fmt = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
        return {
          summary: `${snaps.length} monthly snapshots`,
          blocks: [
            { type: 'stat', items: [{ label: 'First', value: fmt(snaps[0][0]) }, { label: 'Latest', value: fmt(snaps[snaps.length - 1][0]) }, { label: 'Months', value: String(snaps.length) }] },
            { type: 'list', items: snaps.reverse().slice(0, 60).map(([ts, orig, code]) => ({ title: fmt(ts), subtitle: `${orig} · ${code}`, href: `https://web.archive.org/web/${ts}/${orig}` })) },
          ],
        };
      },
    },
    {
      id: 'image',
      name: 'Reverse image search',
      description: 'Open an image URL in every major reverse-image engine.',
      trigger: 'img',
      inputs: [{ key: 'url', label: 'Image URL', required: true, type: 'url' }],
      async run(input) {
        const u = encodeURIComponent(toUrl(str(input, 'url')));
        return {
          blocks: [
            { type: 'actions', items: [
              { label: 'Google Lens', href: `https://lens.google.com/uploadbyurl?url=${u}` },
              { label: 'Yandex', href: `https://yandex.com/images/search?rpt=imageview&url=${u}` },
              { label: 'Bing', href: `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${u}` },
              { label: 'TinEye', href: `https://tineye.com/search?url=${u}` },
              { label: 'SauceNAO', href: `https://saucenao.com/search.php?url=${u}` },
            ] },
          ],
        };
      },
    },
    {
      id: 'dorks',
      name: 'Dork builder',
      description: 'Ready-made search dorks for a domain: exposed files, logins, pastes, buckets.',
      trigger: 'dork',
      inputs: [{ key: 'domain', label: 'Domain', required: true }],
      async run(input) {
        const d = toHostname(str(input, 'domain'));
        const g = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
        const dorks: [string, string][] = [
          ['Documents', `site:${d} (ext:pdf OR ext:doc OR ext:docx OR ext:xls OR ext:xlsx OR ext:ppt)`],
          ['Config & backups', `site:${d} (ext:env OR ext:ini OR ext:conf OR ext:bak OR ext:sql OR ext:log)`],
          ['Login pages', `site:${d} (inurl:login OR inurl:signin OR inurl:admin OR intitle:"login")`],
          ['Directory listings', `site:${d} intitle:"index of"`],
          ['Subdomains (not www)', `site:*.${d} -www`],
          ['Pastes mentioning it', `"${d}" (site:pastebin.com OR site:ghostbin.com OR site:paste.ee)`],
          ['Code mentioning it', `"${d}" (site:github.com OR site:gitlab.com)`],
          ['Cloud buckets', `"${d}" (site:s3.amazonaws.com OR site:blob.core.windows.net OR site:storage.googleapis.com)`],
          ['Error pages', `site:${d} ("sql syntax" OR "stack trace" OR "Warning:" OR "Fatal error")`],
        ];
        return {
          blocks: [
            { type: 'list', items: dorks.map(([label, q]) => ({ title: label, subtitle: q, href: g(q), actions: [{ label: 'DDG', href: `https://duckduckgo.com/?q=${encodeURIComponent(q)}` }, { label: 'Copy', copy: q }] })) },
            pivots(d),
          ],
        };
      },
    },
  ],
});
