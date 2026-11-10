/**
 * Runs `docker compose` on the optional services stack (infra/), with the
 * aria2 secret glogg keeps for this install, as glogg's Services page does.
 *
 *   npm run services:up      npm run services:down      tsx scripts/services.ts <compose args>
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { composeEnv } from '../server/containerManager.js';

const file = path.resolve(import.meta.dirname, '..', 'infra', 'docker-compose.services.yml');
const r = spawnSync('docker', ['compose', '-f', file, ...process.argv.slice(2)], { stdio: 'inherit', env: composeEnv() });
process.exit(r.status ?? 1);
