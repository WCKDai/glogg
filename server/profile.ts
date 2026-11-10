/**
 * Your web-app settings, kept by glogg when you ask (Settings → Your
 * settings → Save to this glogg), so another browser or device can load them.
 * One JSON object, at most 256 KB, readable only by glogg's user.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BYTES = 256 * 1024;
const file = () => path.join(process.env.GLOGG_HOME || path.join(os.homedir(), '.glogg'), 'profile.json');

export interface StoredProfile {
  savedAt: string;
  settings: Record<string, unknown>;
}

export function loadProfile(): StoredProfile | null {
  try {
    const p = JSON.parse(fs.readFileSync(file(), 'utf8')) as StoredProfile;
    return p && typeof p.settings === 'object' && p.settings !== null ? p : null;
  } catch {
    return null;
  }
}

/** Saves `settings`, or throws a message for the person who sent it. */
export function saveProfile(settings: unknown): StoredProfile {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error('settings must be an object');
  const profile: StoredProfile = { savedAt: new Date().toISOString(), settings: settings as Record<string, unknown> };
  const text = JSON.stringify(profile);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Those settings are too big to keep (over 256 KB).');
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), text, { mode: 0o600 });
  return profile;
}
