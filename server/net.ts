/**
 * Outgoing connection defaults for the server and CLI.
 *
 * Node's "happy eyeballs" gives each address of a host a few hundred ms to
 * connect before moving on, and fails the request when every attempt runs out.
 * On networks without working IPv6, or with slow connects, that fails real
 * requests outright: measured on 40 parallel fetches, 6–31 failed with
 * UND_ERR_CONNECT_TIMEOUT, against 0–3 when connecting IPv4-first with the
 * normal connect timeout. glogg fans out to many hosts at once, so it uses the
 * latter. Set GLOGG_HAPPY_EYEBALLS=1 to keep Node's default.
 */
import dns from 'node:dns';
import net from 'node:net';

export function configureNetwork(env: Record<string, string | undefined> = process.env): void {
  if (env.GLOGG_HAPPY_EYEBALLS === '1') return;
  net.setDefaultAutoSelectFamily(false);
  dns.setDefaultResultOrder('ipv4first');
}
