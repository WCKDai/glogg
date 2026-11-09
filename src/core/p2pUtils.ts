import { P2PMetadata } from './types.js';

export const OPEN_DHT_TRACKERS: string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'wss://tracker.openwebtorrent.com',
];

export function isValidInfoHash(hash: string): boolean {
  const clean = hash.trim();
  // 40-char hex (BT v1 SHA-1), 32-char base32, or 64-char hex (BT v2 SHA-256)
  return /^[a-fA-F0-9]{40}$/.test(clean) || /^[a-zA-Z2-7]{32}$/.test(clean) || /^[a-fA-F0-9]{64}$/.test(clean);
}

export function buildMagnetUri(
  infoHash: string,
  displayName: string,
  extraTrackers: string[] = []
): string {
  const cleanHash = infoHash.trim().toLowerCase();
  const dn = encodeURIComponent(displayName.trim());
  const trackers = Array.from(new Set([...extraTrackers, ...OPEN_DHT_TRACKERS]));
  const trParams = trackers.map((tr) => `&tr=${encodeURIComponent(tr)}`).join('');
  return `magnet:?xt=urn:btih:${cleanHash}&dn=${dn}${trParams}`;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes) || bytes <= 0) {
    return 'Unknown';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let unitIdx = 0;
  while (val >= 1024 && unitIdx < units.length - 1) {
    val /= 1024;
    unitIdx += 1;
  }
  return `${val >= 100 ? Math.round(val) : val.toFixed(unitIdx >= 2 ? 2 : 1)} ${units[unitIdx]}`;
}

const P2P_MALWARE_SPAM_PATTERNS: RegExp[] = [
  /\.(?:exe|scr|bat|cmd|vbs|lnk|msi|ps1)\b/i,
  /\b(?:codec\s*pack\s*required|password\s*is\s*in\s*readme|download\s*player\s*to\s*watch)\b/i,
  /\b(?:cracked\s*by\s*free-download|serial-keygen-activator)\b/i,
];

export function assessP2PHealth(input: {
  title: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  isArchivalSeedbox?: boolean;
  protocol: 'bittorrent-dht' | 'usenet-nzb';
  par2Status?: 'verified' | 'complete' | 'unverified';
}): P2PMetadata['healthVerdict'] {
  // Check for known malware/fake patterns
  if (P2P_MALWARE_SPAM_PATTERNS.some((rx) => rx.test(input.title))) {
    // Allow legitimate Linux/Archive ISOs or installers only if archival seedbox
    if (!input.isArchivalSeedbox) {
      return 'suspect-spam';
    }
  }

  // Video/ISO claiming < 2MB is usually a fake stub
  if (
    /\b(?:1080p|2160p|4k|bluray|dvdrip|x265|hevc)\b/i.test(input.title) &&
    input.sizeBytes !== undefined &&
    input.sizeBytes > 0 &&
    input.sizeBytes < 5 * 1024 * 1024
  ) {
    return 'suspect-spam';
  }

  if (input.isArchivalSeedbox) {
    return 'archival-seedbox';
  }

  if (input.protocol === 'usenet-nzb') {
    if (input.par2Status === 'verified' || input.par2Status === 'complete') {
      return 'verified-swarm';
    }
    return 'active';
  }

  const seeds = input.seeders ?? 0;
  if (seeds >= 20) return 'verified-swarm';
  if (seeds >= 3) return 'active';
  return 'low-seed';
}
