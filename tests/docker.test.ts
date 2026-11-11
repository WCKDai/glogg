/**
 * The Docker setups pass on what .env sets: every setting .env.example
 * documents reaches glogg, except where it listens and keeps its data, which
 * the image sets. Before, only four did, so keys put in .env did nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');
const documented = [...read('.env.example').matchAll(/^# ([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
/** Each `NAME: ${NAME…}` (or `- NAME=${NAME…}`) line: a setting passed on from the environment. */
const passedOn = (compose: string) => new Set([...compose.matchAll(/^\s+-? ?([A-Z][A-Z0-9_]+)[:=] ?\$\{\1(?::-[^}]*)?\}/gm)].map((m) => m[1]));
/** The image's (where glogg listens and keeps its data), and GLOGG_PORT, which Compose itself uses. */
const NOT_PASSED = ['HOST', 'PORT', 'GLOGG_HOME', 'GLOGG_DOWNLOADS_DIR', 'GLOGG_CONTAINER_RUNTIME', 'GLOGG_PORT'];

describe('Docker Compose', () => {
  it('passes every setting .env.example documents on to glogg, but not where it listens or keeps its data', () => {
    const passed = passedOn(read('docker-compose.yml'));
    expect(documented.length).toBeGreaterThan(25);
    expect(documented.filter((v) => !NOT_PASSED.includes(v) && !passed.has(v))).toEqual([]);
    expect(NOT_PASSED.filter((v) => passed.has(v))).toEqual([]);
  });

  it("passes the search keys and indexers on in Coolify's setup too", () => {
    const passed = passedOn(read('docker-compose.coolify.yml'));
    const keys = ['MARGINALIA_API_KEY', 'STACKEXCHANGE_KEY', 'BRAVE_API_KEY', 'TORZNAB_URL', 'TORZNAB_API_KEY', 'NEWZNAB_URL', 'NEWZNAB_API_KEY', 'NZBLIFE_URL', 'NZBLIFE_API_KEY', 'GLOGG_ALLOWED_ORIGINS'];
    expect(keys.filter((v) => !passed.has(v))).toEqual([]);
  });
});
