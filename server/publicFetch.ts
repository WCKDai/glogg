/**
 * Fetching addresses that come from outside: pages for the reader and
 * research (often from search results), and feeds for the deep index (often
 * from public directories). Only public internet addresses, checked again at
 * every redirect, so a result or directory entry can't make glogg read your
 * router, a cloud metadata service or the services on this machine.
 *
 *   GLOGG_ALLOW_PRIVATE_FETCH=1  also fetch private and local addresses (to read pages on your own network)
 *
 * A name is checked by resolving it first; a DNS server that answers
 * differently a moment later could still slip through that window.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  PRIVATE.addSubnet(prefix, bits, 'ipv4');
}
for (const [prefix, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE.addSubnet(prefix, bits, 'ipv6');
}

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`${host} is a private or local address, and glogg only fetches public pages. Set GLOGG_ALLOW_PRIVATE_FETCH=1 to allow it.`);
    this.name = 'PrivateAddressError';
  }
}

/** True for loopback, private, link-local, reserved and similar addresses, IPv4 inside IPv6 included. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) return PRIVATE.check(ip, 'ipv4');
  if (family !== 6) return true;
  // ::ffff:10.0.0.1, ::ffff:a00:1 and the NAT64 prefix carry an IPv4 address.
  const tail = /^(?:::ffff:(?:0:)?|64:ff9b::)(.+)$/.exec(ip)?.[1];
  if (tail) {
    if (net.isIPv4(tail)) return PRIVATE.check(tail, 'ipv4');
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (m) {
      const n = (parseInt(m[1], 16) << 16) | parseInt(m[2], 16);
      return PRIVATE.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
    }
  }
  return PRIVATE.check(ip, 'ipv6');
}

const allowPrivate = () => process.env.GLOGG_ALLOW_PRIVATE_FETCH === '1';

type Lookup = (host: string) => Promise<{ address: string }[]>;
const systemLookup: Lookup = (host) => dns.lookup(host, { all: true, verbatim: true });

/** Throws unless `url` is http(s) on a public address. */
export async function assertPublicUrl(url: URL, lookup: Lookup = systemLookup): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) addresses can be fetched, not ${url.protocol}`);
  if (allowPrivate()) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host);
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw new PrivateAddressError(url.hostname);
}

/**
 * fetch() for outside addresses: refuses private ones, follows up to five
 * redirects itself so each hop is checked, and returns the final response.
 */
export async function publicFetch(input: string | URL, init: RequestInit = {}, lookup: Lookup = systemLookup): Promise<Response> {
  let url = new URL(String(input));
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url, lookup);
    const res = await fetch(url, { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location || init.redirect === 'manual') return res;
    if (init.redirect === 'error') throw new TypeError('Redirected');
    await res.body?.cancel().catch(() => undefined);
    if (hop >= 5) throw new Error('Too many redirects');
    url = new URL(location, url);
  }
}

/** A response's text, reading no more than `maxBytes`. */
export async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  return (await readCapped(res, maxBytes)).toString('utf8');
}

/** A response's bytes, reading no more than `maxBytes` (the result is that long when the body was longer). */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}
