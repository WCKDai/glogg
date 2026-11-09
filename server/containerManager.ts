import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ContainerServiceStatus, ContainerStackReport } from '../src/core/types.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const MANAGED_SERVICES: Omit<
  ContainerServiceStatus,
  'state' | 'reachable' | 'containerId' | 'statusText'
>[] = [
  {
    id: 'searxng',
    name: 'SearXNG Uncensored Meta-Node',
    containerName: 'glogg-searxng',
    image: 'docker.io/searxng/searxng:latest',
    category: 'Meta-Search',
    description:
      '70+ engine open-source metasearch instance pre-configured with JSON API, SafeSearch=0 (unfiltered), Marginalia, Wiby, Anna’s Archive, and torrent trackers.',
    webUrl: 'http://localhost:8080',
    apiUrl: 'http://localhost:8080/search?format=json',
    ports: ['8080:8080'],
  },
  {
    id: 'bitmagnet',
    name: 'Bitmagnet DHT Node',
    containerName: 'glogg-bitmagnet',
    image: 'ghcr.io/bitmagnet-io/bitmagnet:latest',
    category: 'P2P & DHT',
    description:
      'Self-hosted BitTorrent DHT network crawler, classifier & GraphQL/Torznab search engine (configured with delete_xxx: false for unfiltered 18+ indexing).',
    webUrl: 'http://localhost:3333',
    apiUrl: 'http://localhost:3333/graphql',
    ports: ['3333:3333', '3334:3334/tcp+udp'],
  },
  {
    id: 'ipfs-kubo',
    name: 'Kubo IPFS Node & Gateway',
    containerName: 'glogg-ipfs',
    image: 'docker.io/ipfs/kubo:latest',
    category: 'Decentralized Web',
    description:
      'Official Go IPFS daemon providing content-addressed CIDv1/IPNS resolution, DHT routing, and local HTTP gateway at :8081/ipfs/<cid>.',
    webUrl: 'http://localhost:5001/webui',
    apiUrl: 'http://localhost:8081',
    ports: ['8081:8080', '5001:5001', '4001:4001'],
  },
  {
    id: 'aria2-rpc',
    name: 'Aria2 Pro RPC Download Engine',
    containerName: 'glogg-aria2',
    image: 'docker.io/p3terx/aria2-pro:latest',
    category: 'Download & Cloud',
    description:
      'High-speed multi-connection HTTP/FTP/BitTorrent/Magnet JSON-RPC download daemon bound to :6800/jsonrpc and ./downloads.',
    webUrl: 'http://localhost:6800/jsonrpc',
    apiUrl: 'http://localhost:6800/jsonrpc',
    ports: ['6800:6800', '6888:6888'],
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud WebDAV & File Vault',
    containerName: 'glogg-nextcloud',
    image: 'docker.io/library/nextcloud:stable-alpine',
    category: 'Download & Cloud',
    description:
      'Self-hosted Nextcloud instance & WebDAV target for pushing NZBs, torrents, and archived pages directly into your private cloud.',
    webUrl: 'http://localhost:8088',
    apiUrl: 'http://localhost:8088/remote.php/dav/files/admin/',
    ports: ['8088:80'],
  },
  {
    id: 'prowlarr',
    name: 'Prowlarr Indexer Proxy',
    containerName: 'glogg-prowlarr',
    image: 'lscr.io/linuxserver/prowlarr:latest',
    category: 'P2P & Usenet',
    description:
      'Unified Torznab & Newznab indexer manager supporting 500+ public, semi-private, and private torrent trackers and Usenet providers.',
    webUrl: 'http://localhost:9696',
    apiUrl: 'http://localhost:9696',
    ports: ['9696:9696'],
  },
  {
    id: 'nzbhydra2',
    name: 'NZBHydra2 Usenet Aggregator',
    containerName: 'glogg-nzbhydra2',
    image: 'lscr.io/linuxserver/nzbhydra2:latest',
    category: 'Usenet NZB',
    description:
      'Usenet meta-search engine federating Newznab providers (including NZB.life), Binsearch, and NZBIndex.',
    webUrl: 'http://localhost:5076',
    apiUrl: 'http://localhost:5076/api',
    ports: ['5076:5076'],
  },
];

async function checkBinaryExists(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin], { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function checkPortReachable(url: string, timeoutMs = 800): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal });
    return r.status < 502;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function getContainerStackStatus(): Promise<ContainerStackReport> {
  const [hasDocker, hasPodman, hasColima] = await Promise.all([
    checkBinaryExists('docker'),
    checkBinaryExists('podman'),
    checkBinaryExists('colima'),
  ]);

  let activeRuntime: 'docker' | 'podman' | 'none' = hasDocker
    ? 'docker'
    : hasPodman
    ? 'podman'
    : 'none';
  let daemonRunning = false;

  if (hasDocker) {
    try {
      await execFileAsync('docker', ['info'], { timeout: 2000 });
      daemonRunning = true;
      activeRuntime = 'docker';
    } catch {
      daemonRunning = false;
    }
  }

  if (!daemonRunning && hasPodman) {
    try {
      await execFileAsync('podman', ['info'], { timeout: 2000 });
      daemonRunning = true;
      activeRuntime = 'podman';
    } catch {
      // keep false
    }
  }

  const runningMap = new Map<
    string,
    { id: string; state: 'running' | 'stopped'; status: string }
  >();

  if (daemonRunning && activeRuntime !== 'none') {
    try {
      const { stdout } = await execFileAsync(
        activeRuntime,
        ['ps', '-a', '--format', '{{.Names}}\t{{.ID}}\t{{.State}}\t{{.Status}}'],
        { timeout: 2500 }
      );
      for (const line of stdout.split(/\r?\n/)) {
        const [name, id, state, status] = line.trim().split('\t');
        if (name) {
          runningMap.set(name, {
            id,
            state: state === 'running' ? 'running' : 'stopped',
            status: status || state,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  const services: ContainerServiceStatus[] = await Promise.all(
    MANAGED_SERVICES.map(async (svc) => {
      const reachable = await checkPortReachable(svc.webUrl);
      const containerInfo = runningMap.get(svc.containerName);
      let state: ContainerServiceStatus['state'] = 'not-created';
      if (containerInfo) {
        state = containerInfo.state;
      } else if (reachable) {
        state = 'running';
      }

      return {
        ...svc,
        state,
        reachable,
        containerId: containerInfo?.id,
        statusText:
          containerInfo?.status ||
          (reachable ? 'Online (Host/Port Active)' : daemonRunning ? 'Ready to deploy' : 'Daemon offline'),
      };
    })
  );

  return {
    runtimes: {
      docker: hasDocker,
      podman: hasPodman,
      colima: hasColima,
    },
    activeRuntime,
    daemonRunning,
    composeFilePath: path.join(REPO_ROOT, 'docker-compose.yml'),
    services,
  };
}

export async function runContainerOrchestrationAction(params: {
  action: 'up' | 'stop' | 'restart' | 'logs' | 'stack-up' | 'stack-down' | 'start-daemon';
  serviceId?: string;
  preferredRuntime?: 'docker' | 'podman';
}): Promise<{ ok: boolean; command: string; output: string }> {
  const status = await getContainerStackStatus();
  const runtime =
    params.preferredRuntime ||
    (status.activeRuntime !== 'none' ? status.activeRuntime : status.runtimes.podman ? 'podman' : 'docker');

  if (params.action === 'start-daemon') {
    if (status.runtimes.colima && runtime === 'docker') {
      try {
        const { stdout, stderr } = await execFileAsync('colima', ['start'], {
          cwd: REPO_ROOT,
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return {
          ok: true,
          command: 'colima start',
          output: `${stdout}\n${stderr}`.trim() || 'Colima daemon started.',
        };
      } catch (err) {
        return {
          ok: false,
          command: 'colima start',
          output: err instanceof Error ? err.message : 'Failed to start Colima daemon',
        };
      }
    }
    if (runtime === 'podman') {
      try {
        const { stdout, stderr } = await execFileAsync('podman', ['machine', 'start'], {
          cwd: REPO_ROOT,
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return {
          ok: true,
          command: 'podman machine start',
          output: `${stdout}\n${stderr}`.trim() || 'Podman machine started.',
        };
      } catch (err) {
        return {
          ok: false,
          command: 'podman machine start',
          output: err instanceof Error ? err.message : 'Failed to start Podman machine',
        };
      }
    }
    try {
      await execFileAsync('open', ['-a', 'Docker'], { timeout: 4000 });
      return {
        ok: true,
        command: 'open -a Docker',
        output: 'Triggered Docker Desktop launch on macOS. Wait a few seconds for daemon initialization.',
      };
    } catch (err) {
      return {
        ok: false,
        command: 'open -a Docker',
        output: err instanceof Error ? err.message : 'Could not launch Docker daemon automatically.',
      };
    }
  }

  const validServiceIds = new Set(MANAGED_SERVICES.map((s) => s.id));
  if (params.serviceId && !validServiceIds.has(params.serviceId)) {
    return {
      ok: false,
      command: '',
      output: `Unknown service ID: ${params.serviceId}`,
    };
  }

  // Ensure Homebrew Docker CLI plugins directory is registered in ~/.docker/config.json
  try {
    const brewPluginDir = '/opt/homebrew/lib/docker/cli-plugins';
    if (fs.existsSync(brewPluginDir)) {
      const dockerDir = path.join(os.homedir(), '.docker');
      const cfgPath = path.join(dockerDir, 'config.json');
      let cfg: Record<string, unknown> = {};
      if (fs.existsSync(cfgPath)) {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      } else {
        fs.mkdirSync(dockerDir, { recursive: true });
      }
      const existing = Array.isArray(cfg.cliPluginsExtraDirs)
        ? (cfg.cliPluginsExtraDirs as string[])
        : [];
      if (!existing.includes(brewPluginDir)) {
        cfg.cliPluginsExtraDirs = [...existing, brewPluginDir];
        fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, '\t')}\n`, 'utf8');
      }
    }
  } catch {
    // ignore config write errors
  }

  if (
    !status.daemonRunning &&
    (params.action === 'up' || params.action === 'stack-up') &&
    status.runtimes.colima &&
    runtime === 'docker'
  ) {
    try {
      await execFileAsync('colima', ['start'], {
        cwd: REPO_ROOT,
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      // continue
    }
  }

  let composeSubArgs: string[] = [];
  if (params.action === 'stack-up') {
    composeSubArgs = ['up', '-d', '--quiet-pull'];
  } else if (params.action === 'stack-down') {
    composeSubArgs = ['down'];
  } else if (params.action === 'up' && params.serviceId) {
    composeSubArgs = ['up', '-d', '--quiet-pull', params.serviceId];
  } else if (params.action === 'stop' && params.serviceId) {
    composeSubArgs = ['stop', params.serviceId];
  } else if (params.action === 'restart' && params.serviceId) {
    composeSubArgs = ['restart', params.serviceId];
  } else if (params.action === 'logs' && params.serviceId) {
    composeSubArgs = ['logs', '--tail=60', params.serviceId];
  } else {
    return { ok: false, command: '', output: 'Invalid action or missing serviceId' };
  }

  const args = ['compose', ...composeSubArgs];
  const cmdString = `${runtime} ${args.join(' ')}`;
  try {
    const { stdout, stderr } = await execFileAsync(runtime, args, {
      cwd: REPO_ROOT,
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ok: true,
      command: cmdString,
      output: `${stdout}\n${stderr}`.trim() || `Executed: ${cmdString}`,
    };
  } catch (err) {
    const standaloneBin = runtime === 'podman' ? 'podman-compose' : 'docker-compose';
    const fallbackArgs = composeSubArgs.filter((a) => a !== '--quiet-pull');
    try {
      const { stdout, stderr } = await execFileAsync(standaloneBin, fallbackArgs, {
        cwd: REPO_ROOT,
        timeout: 240000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return {
        ok: true,
        command: `${standaloneBin} ${fallbackArgs.join(' ')}`,
        output: `${stdout}\n${stderr}`.trim() || `Executed: ${standaloneBin} ${fallbackArgs.join(' ')}`,
      };
    } catch {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        command: cmdString,
        output: msg,
      };
    }
  }
}
