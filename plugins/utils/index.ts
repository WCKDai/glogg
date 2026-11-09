import { createHash, randomUUID } from 'node:crypto';
import { definePlugin, fail, str } from '../../server/plugins/sdk.js';

export function parseMagnet(uri: string) {
  if (!uri.startsWith('magnet:?')) fail('Not a magnet link.');
  const params = new URLSearchParams(uri.slice(8));
  const xt = params.getAll('xt').find((x) => x.startsWith('urn:btih:')) || '';
  let hash = xt.replace('urn:btih:', '');
  if (/^[A-Z2-7]{32}$/i.test(hash)) {
    // base32 → hex
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of hash.toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
    hash = bits.match(/.{4}/g)!.map((b) => parseInt(b, 2).toString(16)).join('');
  }
  return {
    hash: hash.toLowerCase(),
    name: params.get('dn') || '',
    size: Number(params.get('xl') || 0),
    trackers: params.getAll('tr'),
    webSeeds: params.getAll('ws'),
  };
}

export default definePlugin({
  id: 'utils',
  name: 'Utilities',
  description: 'Hashes, encoders, JWT decoder, timestamps, UUIDs and a magnet inspector. Runs locally.',
  category: 'utility',
  icon: 'Wrench',
  tools: [
    {
      id: 'hash',
      name: 'Hash',
      description: 'MD5, SHA-1, SHA-256 and SHA-512 of text.',
      trigger: 'hash',
      inputs: [{ key: 'text', label: 'Text', type: 'textarea', required: true }],
      async run(input) {
        const t = str(input, 'text');
        return { blocks: [{ type: 'kv', items: ['md5', 'sha1', 'sha256', 'sha512'].map((a) => ({ label: a.toUpperCase(), value: createHash(a).update(t).digest('hex') })) }] };
      },
    },
    {
      id: 'encode',
      name: 'Encode / decode',
      description: 'Base64, URL and hex — both directions.',
      trigger: 'b64',
      inputs: [
        { key: 'text', label: 'Text', type: 'textarea', required: true },
        { key: 'mode', label: 'Mode', type: 'select', default: 'auto', options: [{ value: 'auto', label: 'Show all' }, { value: 'decode', label: 'Decode' }] },
      ],
      async run(input) {
        const t = str(input, 'text');
        const safe = (fn: () => string) => { try { return fn(); } catch { return '—'; } };
        if (str(input, 'mode') === 'decode') {
          return { blocks: [{ type: 'kv', items: [
            { label: 'Base64 →', value: safe(() => Buffer.from(t, 'base64').toString('utf8')) },
            { label: 'URL →', value: safe(() => decodeURIComponent(t)) },
            { label: 'Hex →', value: safe(() => Buffer.from(t.replace(/\s/g, ''), 'hex').toString('utf8')) },
          ] }] };
        }
        return { blocks: [{ type: 'kv', items: [
          { label: 'Base64', value: Buffer.from(t).toString('base64') },
          { label: 'Base64url', value: Buffer.from(t).toString('base64url') },
          { label: 'URL', value: encodeURIComponent(t) },
          { label: 'Hex', value: Buffer.from(t).toString('hex') },
        ] }] };
      },
    },
    {
      id: 'jwt',
      name: 'JWT decode',
      description: 'Header, claims and expiry (signature not verified).',
      trigger: 'jwt',
      inputs: [{ key: 'token', label: 'Token', type: 'textarea', required: true }],
      async run(input) {
        const parts = str(input, 'token').split('.');
        if (parts.length < 2) fail('Not a JWT.');
        const dec = (p: string) => JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
        const header = dec(parts[0]);
        const claims = dec(parts[1]);
        const exp = typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : undefined;
        return {
          blocks: [
            ...(exp ? [{ type: 'notice' as const, tone: exp.getTime() < Date.now() ? ('bad' as const) : ('ok' as const), content: `${exp.getTime() < Date.now() ? 'Expired' : 'Expires'} ${exp.toISOString()}` }] : []),
            { type: 'code', title: 'Header', content: JSON.stringify(header, null, 2), language: 'json' },
            { type: 'code', title: 'Claims', content: JSON.stringify(claims, null, 2), language: 'json' },
          ],
        };
      },
    },
    {
      id: 'time',
      name: 'Timestamp',
      description: 'Unix ↔ ISO, in UTC and local time.',
      trigger: 'ts',
      inputs: [{ key: 'value', label: 'Unix seconds/ms or date', placeholder: 'now' }],
      async run(input) {
        const v = str(input, 'value');
        const n = Number(v);
        const d = !v || v === 'now' ? new Date() : Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
        if (Number.isNaN(d.getTime())) fail('Unrecognised date.');
        return { blocks: [{ type: 'kv', items: [
          { label: 'ISO (UTC)', value: d.toISOString() },
          { label: 'Local', value: d.toString() },
          { label: 'Unix (s)', value: String(Math.floor(d.getTime() / 1000)) },
          { label: 'Unix (ms)', value: String(d.getTime()) },
        ] }] };
      },
    },
    {
      id: 'uuid',
      name: 'UUIDs',
      description: 'Random v4 UUIDs.',
      trigger: 'uuid',
      inputs: [{ key: 'count', label: 'How many', type: 'number', default: 5 }],
      async run(input) {
        const n = Math.min(100, Math.max(1, Number(input.count) || 5));
        return { blocks: [{ type: 'code', content: Array.from({ length: n }, () => randomUUID()).join('\n') }] };
      },
    },
    {
      id: 'magnet',
      name: 'Magnet inspector',
      description: 'Info hash, name, trackers — and where to look it up.',
      trigger: 'magnet',
      inputs: [{ key: 'uri', label: 'Magnet link', type: 'textarea', required: true }],
      async run(input) {
        const m = parseMagnet(str(input, 'uri'));
        return {
          summary: m.name || m.hash,
          blocks: [
            { type: 'kv', items: [{ label: 'Name', value: m.name || '—' }, { label: 'Info hash', value: m.hash }, { label: 'Trackers', value: String(m.trackers.length) }] },
            { type: 'actions', items: [
              { label: 'Send', send: { url: str(input, 'uri'), title: m.name } },
              { label: 'Check TorBox cache', run: { tool: 'torbox/cached', inputs: { hash: m.hash } } },
              { label: 'BTDigg', href: `https://btdig.com/search?q=${m.hash}` },
              { label: 'iTorrents', href: `https://itorrents.org/torrent/${m.hash.toUpperCase()}.torrent` },
            ] },
            { type: 'list', title: 'Trackers', items: m.trackers.map((t) => ({ title: t })) },
          ],
        };
      },
    },
  ],
});
