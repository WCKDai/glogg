/**
 * Container orchestration against fake runtimes: docker, podman, colima and
 * which are shell scripts in a temp folder that is the whole PATH. Each logs
 * its arguments and prints canned output, so no real runtime ever runs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { MANAGED_SERVICES, getContainerStackStatus, runContainerOrchestrationAction } from '../server/containerManager.js';
import { anyString, BASE_SEED, rng, text } from './fuzz.js';

const COMPOSE = path.resolve(import.meta.dirname, '..', 'infra', 'docker-compose.services.yml');
const BREW_PLUGINS = '/opt/homebrew/lib/docker/cli-plugins';
const FAKES = ['which', 'docker', 'podman', 'colima', 'docker-compose', 'podman-compose', 'open'];

type Reply = { out?: string; err?: string; code?: number };

let store = '';
let bin = '';
let log = '';
let brewPluginsPresent = false;
let ports: Record<string, number> = {};
const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GLOGG_CONTAINER_RUNTIME: process.env.GLOGG_CONTAINER_RUNTIME };

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// macOS scans each new executable on its first launch (up to ~300 ms), so the
// scripts are written once and each test's PATH folder links to the ones it installs.
beforeAll(() => {
  const root = inject('tmpRoot');
  fs.mkdirSync(root, { recursive: true });
  store = fs.mkdtempSync(path.join(root, 'fakes-'));
  for (const name of FAKES) {
    fs.writeFileSync(path.join(store, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    execFileSync(path.join(store, name));
  }
});

function install(name: string, script: string[]): void {
  fs.writeFileSync(path.join(store, name), `${script.join('\n')}\n`);
  if (!fs.existsSync(path.join(bin, name))) fs.symlinkSync(path.join(store, name), path.join(bin, name));
}

/** Installs a fake binary that logs its argv and answers by its first argument ('*' for anything else). */
function fake(name: string, replies: Record<string, Reply> = {}): void {
  install(name, [
    '#!/bin/sh',
    `rec=${q(name)}`,
    `for a in "$@"; do rec="$rec$(printf '\\037')$a"; done`,
    `printf '%s\\036' "$rec" >> ${q(log)}`,
    'case "$1" in',
    ...Object.entries(replies).map(
      ([first, r]) => `  ${first === '*' ? '*' : q(first)}) printf '%s' ${q(r.out ?? '')}; printf '%s' ${q(r.err ?? '')} >&2; exit ${r.code ?? 0} ;;`
    ),
    'esac',
  ]);
}

/** Every call the fakes saw, in order, as [binary, ...args]. */
const calls = () =>
  fs
    .readFileSync(log, 'utf8')
    .split('\x1e')
    .filter(Boolean)
    .map((rec) => rec.split('\x1f'));
const ran = (name: string) => calls().filter((c) => c[0] === name);
const service = (report: Awaited<ReturnType<typeof getContainerStackStatus>>, id: string) => report.services.find((s) => s.id === id)!;

const dockerUp = (ps = '', compose: Reply = { out: 'compose ok' }) =>
  fake('docker', { info: { out: 'Server Version: 27.0' }, ps: { out: ps }, compose });

beforeEach(() => {
  bin = fs.mkdtempSync(path.join(inject('tmpRoot'), 'bin-'));
  log = path.join(bin, 'calls.log');
  fs.writeFileSync(log, '');
  install('which', [
    '#!/bin/sh',
    `printf 'which\\037%s\\036' "$1" >> ${q(log)}`,
    `[ -x ${q(bin)}/"$1" ] && { printf '%s\\n' ${q(bin)}/"$1"; exit 0; }`,
    'exit 1',
  ]);
  process.env.PATH = bin;
  process.env.HOME = bin;
  delete process.env.GLOGG_CONTAINER_RUNTIME;

  brewPluginsPresent = false;
  const realExists = fs.existsSync;
  vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === BREW_PLUGINS ? brewPluginsPresent : realExists(p)));

  ports = {};
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const status = ports[String(input)];
    if (status === undefined) throw new TypeError('fetch failed');
    return new Response('', { status });
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('finding a container runtime', () => {
  it('picks docker when its daemon answers, and reads each glogg container from docker ps', async () => {
    dockerUp(
      [
        'glogg-searxng\tc0ffee01\trunning\tUp 2 hours',
        'glogg-ipfs\tc0ffee02\texited\tExited (0) 3 days ago\r',
        'someone-elses-app\tc0ffee03\trunning\tUp 1 minute',
        '',
      ].join('\n')
    );
    ports['http://localhost:8088'] = 200;

    const report = await getContainerStackStatus();

    expect(report.runtimes).toEqual({ docker: true, podman: false, colima: false });
    expect(report.activeRuntime).toBe('docker');
    expect(report.daemonRunning).toBe(true);
    expect(report.composeFilePath).toBe(COMPOSE);
    expect(report.services.map((s) => s.id)).toEqual(MANAGED_SERVICES.map((s) => s.id));
    expect(service(report, 'searxng')).toMatchObject({ state: 'running', containerId: 'c0ffee01', statusText: 'Up 2 hours', reachable: false });
    expect(service(report, 'ipfs-kubo')).toMatchObject({ state: 'stopped', containerId: 'c0ffee02', statusText: 'Exited (0) 3 days ago' });
    expect(service(report, 'nextcloud')).toMatchObject({ state: 'running', containerId: undefined, statusText: 'Online (Host/Port Active)', reachable: true });
    expect(service(report, 'bitmagnet')).toMatchObject({ state: 'not-created', statusText: 'Ready to deploy' });

    expect(ran('which').map((c) => c[1]).sort()).toEqual(['colima', 'docker', 'podman']);
    expect(ran('docker')).toEqual([
      ['docker', 'info'],
      ['docker', 'ps', '-a', '--format', '{{.Names}}\t{{.ID}}\t{{.State}}\t{{.Status}}'],
    ]);
  });

  it('falls back to podman when docker is installed but its daemon is down', async () => {
    fake('docker', { info: { err: 'Cannot connect to the Docker daemon', code: 1 } });
    fake('podman', { info: { out: 'host: ok' }, ps: { out: 'glogg-prowlarr\tbeef01\trunning\tUp 5 minutes\n' } });

    const report = await getContainerStackStatus();

    expect(report.runtimes).toEqual({ docker: true, podman: true, colima: false });
    expect(report.activeRuntime).toBe('podman');
    expect(report.daemonRunning).toBe(true);
    expect(service(report, 'prowlarr')).toMatchObject({ state: 'running', containerId: 'beef01' });
    expect(ran('docker')).toEqual([['docker', 'info']]);
    expect(ran('podman')).toEqual([
      ['podman', 'info'],
      ['podman', 'ps', '-a', '--format', '{{.Names}}\t{{.ID}}\t{{.State}}\t{{.Status}}'],
    ]);
  });

  it('reports the daemon offline when docker is installed but not running', async () => {
    fake('docker', { info: { code: 1 } });
    fake('colima');
    ports['http://localhost:8080'] = 200;

    const report = await getContainerStackStatus();

    expect(report.runtimes).toEqual({ docker: true, podman: false, colima: true });
    expect(report.activeRuntime).toBe('docker');
    expect(report.daemonRunning).toBe(false);
    expect(service(report, 'searxng')).toMatchObject({ state: 'running', statusText: 'Online (Host/Port Active)' });
    expect(service(report, 'aria2-rpc')).toMatchObject({ state: 'not-created', statusText: 'Daemon offline' });
    expect(ran('docker')).toEqual([['docker', 'info']]);
    expect(ran('colima')).toEqual([]);
  });

  it('finds no runtime when neither docker nor podman is installed', async () => {
    const report = await getContainerStackStatus();

    expect(report.runtimes).toEqual({ docker: false, podman: false, colima: false });
    expect(report.activeRuntime).toBe('none');
    expect(report.daemonRunning).toBe(false);
    expect(report.services.every((s) => s.state === 'not-created' && s.statusText === 'Daemon offline')).toBe(true);
    expect(calls().every((c) => c[0] === 'which')).toBe(true);
  });

  it('keeps every service listed when docker ps fails', async () => {
    fake('docker', { info: {}, ps: { err: 'permission denied', code: 1 } });

    const report = await getContainerStackStatus();

    expect(report.daemonRunning).toBe(true);
    expect(report.services).toHaveLength(MANAGED_SERVICES.length);
    expect(report.services.every((s) => s.state === 'not-created' && s.statusText === 'Ready to deploy')).toBe(true);
  });

  it('counts a port that answers below 502 as reachable, and a 502 as down', async () => {
    dockerUp();
    ports['http://localhost:9696'] = 401;
    ports['http://localhost:5076'] = 502;

    const report = await getContainerStackStatus();

    expect(service(report, 'prowlarr')).toMatchObject({ reachable: true, state: 'running' });
    expect(service(report, 'nzbhydra2')).toMatchObject({ reachable: false, state: 'not-created' });
  });

  it('looks only for docker under GLOGG_CONTAINER_RUNTIME=docker, in any case', async () => {
    process.env.GLOGG_CONTAINER_RUNTIME = 'Docker';
    dockerUp();
    fake('podman', { info: {} });
    fake('colima');

    const report = await getContainerStackStatus();

    expect(report.runtimes).toEqual({ docker: true, podman: false, colima: false });
    expect(ran('which').map((c) => c[1])).toEqual(['docker']);
    expect(ran('podman')).toEqual([]);
  });

  it('looks only for podman under GLOGG_CONTAINER_RUNTIME=podman', async () => {
    process.env.GLOGG_CONTAINER_RUNTIME = 'podman';
    dockerUp();
    fake('podman', { info: {}, ps: { out: '' } });

    const report = await getContainerStackStatus();

    expect(report.runtimes).toEqual({ docker: false, podman: true, colima: false });
    expect(report.activeRuntime).toBe('podman');
    expect(ran('which').map((c) => c[1])).toEqual(['podman']);
    expect(ran('docker')).toEqual([]);
  });

  it('treats an unknown GLOGG_CONTAINER_RUNTIME as auto', async () => {
    process.env.GLOGG_CONTAINER_RUNTIME = 'kubernetes';

    await getContainerStackStatus();

    expect(ran('which').map((c) => c[1]).sort()).toEqual(['colima', 'docker', 'podman']);
  });
});

describe('GLOGG_CONTAINER_RUNTIME=none', () => {
  beforeEach(() => {
    process.env.GLOGG_CONTAINER_RUNTIME = 'none';
    dockerUp();
    fake('podman', { info: {} });
    fake('colima');
    fake('open');
  });

  it('reports no runtime without running anything', async () => {
    ports['http://localhost:8080'] = 200;

    const report = await getContainerStackStatus();

    expect(report).toMatchObject({ runtimes: { docker: false, podman: false, colima: false }, activeRuntime: 'none', daemonRunning: false });
    expect(service(report, 'searxng')).toMatchObject({ state: 'running', statusText: 'Online (Host/Port Active)' });
    expect(service(report, 'bitmagnet').statusText).toBe('Daemon offline');
    expect(calls()).toEqual([]);
  });

  it.each(['up', 'stop', 'restart', 'logs', 'stack-up', 'stack-down', 'start-daemon'] as const)('refuses %s', async (action) => {
    const result = await runContainerOrchestrationAction({ action, serviceId: 'searxng', preferredRuntime: 'docker' });

    expect(result).toEqual({ ok: false, command: '', output: 'Container management is off here (GLOGG_CONTAINER_RUNTIME=none).' });
    expect(calls()).toEqual([]);
  });
});

describe('running compose for one service', () => {
  it.each([
    ['up', ['up', '-d', '--quiet-pull', 'searxng']],
    ['stop', ['stop', 'searxng']],
    ['restart', ['restart', 'searxng']],
    ['logs', ['logs', '--tail=60', 'searxng']],
  ] as const)('runs %s against infra/docker-compose.services.yml', async (action, sub) => {
    dockerUp('', { out: 'searxng done\n', err: 'warning: pulled\n' });

    const result = await runContainerOrchestrationAction({ action, serviceId: 'searxng' });

    expect(result).toEqual({ ok: true, command: `docker compose -f ${COMPOSE} ${sub.join(' ')}`, output: 'searxng done\n\nwarning: pulled' });
    expect(ran('docker').at(-1)).toEqual(['docker', 'compose', '-f', COMPOSE, ...sub]);
  });

  it('accepts every managed service id', async () => {
    dockerUp();

    for (const { id } of MANAGED_SERVICES) {
      expect((await runContainerOrchestrationAction({ action: 'restart', serviceId: id })).ok).toBe(true);
    }

    expect(ran('docker').filter((c) => c[1] === 'compose').map((c) => c.slice(4))).toEqual(MANAGED_SERVICES.map((s) => ['restart', s.id]));
  });

  it('says what it ran when compose prints nothing', async () => {
    dockerUp('', {});

    const result = await runContainerOrchestrationAction({ action: 'stop', serviceId: 'aria2-rpc' });

    expect(result.output).toBe(`Executed: docker compose -f ${COMPOSE} stop aria2-rpc`);
  });

  it('runs podman compose when podman is the active runtime', async () => {
    fake('podman', { info: {}, ps: {}, compose: { out: 'ok' } });

    const result = await runContainerOrchestrationAction({ action: 'up', serviceId: 'nextcloud' });

    expect(result.command).toBe(`podman compose -f ${COMPOSE} up -d --quiet-pull nextcloud`);
    expect(ran('podman').at(-1)).toEqual(['podman', 'compose', '-f', COMPOSE, 'up', '-d', '--quiet-pull', 'nextcloud']);
  });

  it('uses the preferred runtime over the detected one', async () => {
    dockerUp();
    fake('podman', { compose: { out: 'ok' } });

    const result = await runContainerOrchestrationAction({ action: 'logs', serviceId: 'bitmagnet', preferredRuntime: 'podman' });

    expect(result).toMatchObject({ ok: true, command: `podman compose -f ${COMPOSE} logs --tail=60 bitmagnet` });
    expect(ran('docker').some((c) => c[1] === 'compose')).toBe(false);
  });

  it('starts colima first when the docker daemon is down and a service is coming up', async () => {
    fake('docker', { info: { code: 1 }, compose: { out: 'up' } });
    fake('colima', { start: { out: 'colima is running' } });

    const result = await runContainerOrchestrationAction({ action: 'up', serviceId: 'searxng' });

    expect(result.ok).toBe(true);
    expect(calls().filter((c) => c[0] !== 'which')).toEqual([
      ['docker', 'info'],
      ['colima', 'start'],
      ['docker', 'compose', '-f', COMPOSE, 'up', '-d', '--quiet-pull', 'searxng'],
    ]);
  });

  it('carries on to compose when colima fails to start', async () => {
    fake('docker', { info: { code: 1 }, compose: { out: 'up' } });
    fake('colima', { start: { err: 'no VM', code: 1 } });

    const result = await runContainerOrchestrationAction({ action: 'stack-up' });

    expect(result).toMatchObject({ ok: true, command: `docker compose -f ${COMPOSE} up -d --quiet-pull` });
  });

  it("doesn't start colima to stop a service", async () => {
    fake('docker', { info: { code: 1 }, compose: {} });
    fake('colima', { start: {} });

    await runContainerOrchestrationAction({ action: 'stop', serviceId: 'searxng' });

    expect(ran('colima')).toEqual([]);
  });
});

describe('stack up and down', () => {
  it.each([
    ['stack-up', ['up', '-d', '--quiet-pull']],
    ['stack-down', ['down']],
  ] as const)('%s runs compose for the whole services file', async (action, sub) => {
    dockerUp();

    const result = await runContainerOrchestrationAction({ action, serviceId: 'searxng' });

    expect(result).toMatchObject({ ok: true, command: `docker compose -f ${COMPOSE} ${sub.join(' ')}` });
    expect(ran('docker').at(-1)).toEqual(['docker', 'compose', '-f', COMPOSE, ...sub]);
  });
});

describe('compose fallbacks', () => {
  it('tries the standalone docker-compose, without --quiet-pull, when the compose plugin fails', async () => {
    dockerUp('', { err: "docker: 'compose' is not a docker command.", code: 1 });
    fake('docker-compose', { '-f': { out: 'Started glogg-searxng' } });

    const result = await runContainerOrchestrationAction({ action: 'up', serviceId: 'searxng' });

    expect(result).toEqual({ ok: true, command: `docker-compose -f ${COMPOSE} up -d searxng`, output: 'Started glogg-searxng' });
    expect(ran('docker-compose')).toEqual([['docker-compose', '-f', COMPOSE, 'up', '-d', 'searxng']]);
  });

  it('tries podman-compose for podman', async () => {
    fake('podman', { info: {}, ps: {}, compose: { code: 125 } });
    fake('podman-compose', {});

    const result = await runContainerOrchestrationAction({ action: 'stack-down' });

    expect(result).toEqual({ ok: true, command: `podman-compose -f ${COMPOSE} down`, output: `Executed: podman-compose -f ${COMPOSE} down` });
  });

  it('reports the compose error when there is no standalone compose either', async () => {
    dockerUp('', { err: 'no such service: searxng', code: 1 });

    const result = await runContainerOrchestrationAction({ action: 'restart', serviceId: 'searxng' });

    expect(result.ok).toBe(false);
    expect(result.command).toBe(`docker compose -f ${COMPOSE} restart searxng`);
    expect(result.output).toContain(`Command failed: docker compose -f ${COMPOSE} restart searxng`);
    expect(result.output).toContain('no such service: searxng');
  });

  it('falls back to docker, and fails cleanly, when no runtime is installed', async () => {
    const result = await runContainerOrchestrationAction({ action: 'stack-down' });

    expect(result.ok).toBe(false);
    expect(result.command).toBe(`docker compose -f ${COMPOSE} down`);
    expect(result.output).toMatch(/ENOENT/);
  });
});

describe('refusing bad requests', () => {
  it.each(['up', 'stop', 'restart', 'logs'] as const)('refuses %s without a serviceId', async (action) => {
    dockerUp();

    const result = await runContainerOrchestrationAction({ action });

    expect(result).toEqual({ ok: false, command: '', output: 'Invalid action or missing serviceId' });
    expect(ran('docker').some((c) => c[1] === 'compose')).toBe(false);
  });

  it('refuses an action it does not know', async () => {
    dockerUp();

    const result = await runContainerOrchestrationAction({ action: 'destroy' as never, serviceId: 'searxng' });

    expect(result).toEqual({ ok: false, command: '', output: 'Invalid action or missing serviceId' });
    expect(ran('docker').some((c) => c[1] === 'compose')).toBe(false);
  });

  it('refuses a service it does not manage', async () => {
    dockerUp();

    const result = await runContainerOrchestrationAction({ action: 'up', serviceId: 'jellyfin' });

    expect(result).toEqual({ ok: false, command: '', output: 'Unknown service ID: jellyfin' });
    expect(ran('docker').some((c) => c[1] === 'compose')).toBe(false);
  });

  it("can't be steered into other arguments by a serviceId", async () => {
    dockerUp();
    fake('docker-compose');
    const valid = new Set(MANAGED_SERVICES.map((s) => s.id));
    const hostile = [
      '--privileged',
      '-f',
      '/etc/passwd',
      'x; rm -rf /',
      'searxng; rm -rf ~',
      'searxng --privileged',
      'searxng -f /etc/passwd',
      '$(id)',
      '`id`',
      ' searxng',
      'searxng\n',
      'SEARXNG',
      '../searxng',
      'searxng\0',
      ...Array.from({ length: 24 }, (_, i) => (i % 2 ? text(rng(BASE_SEED + i), 5) : anyString(rng(BASE_SEED + i), 24))),
    ].filter((s) => s && !valid.has(s));
    const actions = ['up', 'stop', 'restart', 'logs'] as const;

    for (const [i, serviceId] of hostile.entries()) {
      const result = await runContainerOrchestrationAction({ action: actions[i % actions.length], serviceId });
      expect(result, JSON.stringify(serviceId)).toEqual({ ok: false, command: '', output: `Unknown service ID: ${serviceId}` });
    }

    expect(hostile.length).toBeGreaterThan(30);
    expect(ran('docker').filter((c) => c[1] !== 'info' && c[1] !== 'ps')).toEqual([]);
    expect(ran('docker-compose')).toEqual([]);
  });
});

describe('starting the daemon', () => {
  it('starts colima for docker when colima is installed', async () => {
    fake('docker', { info: { code: 1 } });
    fake('colima', { start: { err: 'INFO starting colima\n' } });

    const result = await runContainerOrchestrationAction({ action: 'start-daemon' });

    expect(result).toEqual({ ok: true, command: 'colima start', output: 'INFO starting colima' });
    expect(ran('colima')).toEqual([['colima', 'start']]);
  });

  it('says so when colima starts silently', async () => {
    fake('docker', { info: { code: 1 } });
    fake('colima', { start: {} });

    expect(await runContainerOrchestrationAction({ action: 'start-daemon' })).toEqual({ ok: true, command: 'colima start', output: 'Colima daemon started.' });
  });

  it('reports a colima failure', async () => {
    fake('docker', { info: { code: 1 } });
    fake('colima', { start: { err: 'FATA no space left', code: 1 } });

    const result = await runContainerOrchestrationAction({ action: 'start-daemon' });

    expect(result.ok).toBe(false);
    expect(result.command).toBe('colima start');
    expect(result.output).toContain('FATA no space left');
  });

  it('starts the podman machine for podman', async () => {
    fake('podman', { info: { code: 125 }, machine: { out: 'Machine "podman-machine-default" started successfully' } });

    const result = await runContainerOrchestrationAction({ action: 'start-daemon' });

    expect(result).toEqual({ ok: true, command: 'podman machine start', output: 'Machine "podman-machine-default" started successfully' });
    expect(ran('podman').at(-1)).toEqual(['podman', 'machine', 'start']);
  });

  it('reports a podman machine failure, and a silent success', async () => {
    fake('podman', { info: { code: 125 }, machine: { err: 'VM does not exist', code: 125 } });
    const failed = await runContainerOrchestrationAction({ action: 'start-daemon' });
    expect(failed).toMatchObject({ ok: false, command: 'podman machine start' });
    expect(failed.output).toContain('VM does not exist');

    fake('podman', { info: { code: 125 }, machine: {} });
    expect((await runContainerOrchestrationAction({ action: 'start-daemon' })).output).toBe('Podman machine started.');
  });

  it('opens Docker Desktop when there is no colima or podman', async () => {
    fake('docker', { info: { code: 1 } });
    fake('open');

    const result = await runContainerOrchestrationAction({ action: 'start-daemon' });

    expect(result).toMatchObject({ ok: true, command: 'open -a Docker' });
    expect(ran('open')).toEqual([['open', '-a', 'Docker']]);
  });

  it('reports when Docker Desktop could not be opened', async () => {
    fake('docker', { info: { code: 1 } });
    fake('open', { '-a': { err: 'Unable to find application named Docker', code: 1 } });

    const result = await runContainerOrchestrationAction({ action: 'start-daemon' });

    expect(result.ok).toBe(false);
    expect(result.command).toBe('open -a Docker');
    expect(result.output).toContain('Unable to find application named Docker');
  });
});

describe('the Homebrew docker CLI plugins folder', () => {
  const dockerConfig = () => path.join(bin, '.docker', 'config.json');

  it('is added to ~/.docker/config.json once, keeping what is there', async () => {
    brewPluginsPresent = true;
    dockerUp();
    fs.mkdirSync(path.dirname(dockerConfig()));
    fs.writeFileSync(dockerConfig(), JSON.stringify({ auths: { 'ghcr.io': {} }, cliPluginsExtraDirs: ['/usr/local/lib/docker/cli-plugins'] }));

    await runContainerOrchestrationAction({ action: 'stack-down' });
    await runContainerOrchestrationAction({ action: 'stack-down' });

    expect(JSON.parse(fs.readFileSync(dockerConfig(), 'utf8'))).toEqual({
      auths: { 'ghcr.io': {} },
      cliPluginsExtraDirs: ['/usr/local/lib/docker/cli-plugins', BREW_PLUGINS],
    });
  });

  it('creates ~/.docker/config.json when there is none', async () => {
    brewPluginsPresent = true;
    dockerUp();

    await runContainerOrchestrationAction({ action: 'stack-down' });

    expect(JSON.parse(fs.readFileSync(dockerConfig(), 'utf8'))).toEqual({ cliPluginsExtraDirs: [BREW_PLUGINS] });
  });

  it('leaves an unreadable config alone and still runs compose', async () => {
    brewPluginsPresent = true;
    dockerUp();
    fs.mkdirSync(path.dirname(dockerConfig()));
    fs.writeFileSync(dockerConfig(), '{ not json');

    const result = await runContainerOrchestrationAction({ action: 'stack-down' });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(dockerConfig(), 'utf8')).toBe('{ not json');
  });

  it('touches nothing in ~/.docker without Homebrew docker', async () => {
    dockerUp();

    await runContainerOrchestrationAction({ action: 'stack-down' });

    expect(fs.existsSync(path.join(bin, '.docker'))).toBe(false);
  });
});

describe('the managed services', () => {
  it('are each a service of infra/docker-compose.services.yml, under the same container name', () => {
    const yml = fs.readFileSync(COMPOSE, 'utf8');
    const names = Object.fromEntries([...yml.matchAll(/^ {2}([\w-]+):\n(?: {4}.*\n)*? {4}container_name: (\S+)/gm)].map((m) => [m[1], m[2]]));

    for (const svc of MANAGED_SERVICES) {
      expect(names[svc.id], svc.id).toBe(svc.containerName);
    }
  });
});
