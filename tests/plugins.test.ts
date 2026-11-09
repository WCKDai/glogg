import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseToolTrigger, PLUGIN_CATEGORY_LABELS } from '../src/core/index.js';
import type { PluginInfo } from '../src/core/index.js';
import { useTempGloggHome } from './helpers.js';

const home = useTempGloggHome();
const rt = await import('../server/plugins/runtime.js');
const { definePlugin, PluginError } = await import('../server/plugins/sdk.js');

let builtins: PluginInfo[] = [];

beforeAll(async () => {
  await rt.loadPlugins({ force: true });
  builtins = rt.listPlugins().filter((p) => p.source === 'builtin');
});

describe('built-in plugins: contract', () => {
  it('all load without errors', () => {
    expect(builtins.map((p) => p.id).sort()).toEqual(
      ['ai', 'nextcloud', 'nzblife', 'offcloud', 'osint', 'pcloud', 'realdebrid', 'sabnzbd', 'torbox', 'utils', 'webtest'].sort()
    );
    expect(rt.listPlugins().filter((p) => p.error)).toEqual([]);
  });

  it('have unique ids, unique tool ids and unique >triggers', () => {
    const triggers = builtins.flatMap((p) => p.tools.map((t) => t.trigger).filter(Boolean));
    expect(new Set(triggers).size).toBe(triggers.length);
    for (const p of builtins) {
      const ids = p.tools.map((t) => t.id);
      expect(new Set(ids).size, p.id).toBe(ids.length);
    }
  });

  it('describe every tool and label every field', () => {
    for (const p of builtins) {
      expect(p.description.length, p.id).toBeGreaterThan(10);
      expect(Object.keys(PLUGIN_CATEGORY_LABELS)).toContain(p.category);
      for (const t of p.tools) {
        expect(t.name, `${p.id}/${t.id}`).toBeTruthy();
        expect(t.description.length, `${p.id}/${t.id}`).toBeGreaterThan(5);
        for (const f of [...t.inputs, ...(p.settings || [])]) {
          expect(f.label, `${p.id}.${f.key}`).toBeTruthy();
          if (f.type === 'select') expect(f.options?.length, `${p.id}.${f.key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('mark keys and passwords as secret so they are masked', () => {
    for (const p of builtins) {
      for (const f of p.settings || []) {
        if (/key|token|password|secret/i.test(f.key)) expect(f.secret || f.type === 'password', `${p.id}.${f.key}`).toBe(true);
      }
    }
  });

  it('expose a trigger the search box can parse', () => {
    for (const p of builtins) {
      for (const t of p.tools.filter((x) => x.trigger)) {
        expect(parseToolTrigger(`>${t.trigger} value`)).toEqual({ trigger: t.trigger, rest: 'value' });
      }
    }
  });

  it('declare download targets only when they can receive downloads', () => {
    const targets = rt.listDownloadTargets();
    expect(targets.map((t) => t.pluginId).sort()).toEqual(['pcloud', 'realdebrid', 'sabnzbd', 'torbox']);
    expect(targets.every((t) => t.configured === false)).toBe(true);
  });
});

describe('plugin validation', () => {
  const tool = { id: 'go', name: 'Go', description: 'Does it', inputs: [], run: async () => ({ blocks: [] }) };
  it.each([
    [{ id: 'Bad Id', name: 'x', category: 'utility', tools: [] }, /invalid id/],
    [{ id: 'ok', category: 'utility', tools: [] }, /missing name/],
    [{ id: 'ok', name: 'x', category: 'utility', tools: [tool, tool] }, /duplicate tool id/],
    [{ id: 'ok', name: 'x', category: 'utility', tools: [{ ...tool, run: undefined }] }, /has no run/],
    [{ id: 'ok', name: 'x', category: 'utility', tools: [], downloadTarget: { label: 'x', accepts: ['nzb'] } }, /without sendDownload/],
    [null, /not an object/],
  ])('rejects %#', (def, msg) => {
    expect(rt.validateDefinition(def)).toMatch(msg);
  });

  it('accepts a minimal plugin', () => {
    expect(rt.validateDefinition({ id: 'ok', name: 'x', category: 'utility', tools: [tool] })).toBeNull();
  });
});

describe('plugin settings', () => {
  const settingsFile = () => path.join(home, 'plugins.json');

  it('stores values with owner-only permissions and applies defaults', () => {
    const saved = rt.savePluginSettings('sabnzbd', { apiKey: 'abcdef123456' });
    expect(saved).toMatchObject({ apiKey: 'abcdef123456', url: 'http://localhost:8085' });
    expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
  });

  it('masks secrets to their last four characters', () => {
    expect(rt.maskPluginSettings('sabnzbd').apiKey).toBe('••••3456');
    expect(rt.maskPluginSettings('sabnzbd').url).toBe('http://localhost:8085');
  });

  it('treats a masked value as unchanged, an empty value as cleared, and ignores unknown keys', () => {
    rt.savePluginSettings('sabnzbd', { apiKey: '••••3456', url: 'http://10.0.0.2:8080', hacker: 'x' });
    expect(rt.getPluginSettings('sabnzbd')).toMatchObject({ apiKey: 'abcdef123456', url: 'http://10.0.0.2:8080' });
    expect(rt.getPluginSettings('sabnzbd')).not.toHaveProperty('hacker');
    rt.savePluginSettings('sabnzbd', { apiKey: '' });
    expect(rt.getPluginSettings('sabnzbd').apiKey).toBeUndefined();
  });

  it('marks a plugin configured once its required settings are filled', () => {
    const configured = () => rt.listPlugins().find((p) => p.id === 'realdebrid')!.configured;
    expect(configured()).toBe(false);
    rt.savePluginSettings('realdebrid', { apiToken: 'tok-123456' });
    expect(configured()).toBe(true);
    rt.savePluginSettings('realdebrid', { apiToken: '' });
  });

  it('refuses settings for an unknown plugin', () => {
    expect(() => rt.savePluginSettings('nope', { a: 'b' })).toThrow(/Unknown plugin/);
  });
});

describe('running tools', () => {
  beforeAll(() => {
    rt.registerPlugin(
      definePlugin({
        id: 'testkit',
        name: 'Test kit',
        description: 'Fixtures for the runtime tests',
        category: 'utility',
        settings: [{ key: 'token', label: 'Token', secret: true, required: true }],
        tools: [
          { id: 'echo', name: 'Echo', description: 'Echoes', inputs: [{ key: 'text', label: 'Text', required: true }], run: async (i) => ({ blocks: [{ type: 'text', content: String(i.text) }] }) },
          { id: 'hang', name: 'Hang', description: 'Never ends', inputs: [], run: () => new Promise(() => undefined) },
          { id: 'boom', name: 'Boom', description: 'Fails', inputs: [], run: async () => { throw new PluginError('Upstream said no'); } },
          { id: 'secret', name: 'Secret', description: 'Needs setup', inputs: [], requiresSettings: true, run: async () => ({ blocks: [] }) },
          {
            id: 'aborts',
            name: 'Aborts',
            description: 'Watches its signal',
            inputs: [],
            run: (_i, ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new PluginError('aborted by caller')))),
          },
        ],
      })
    );
  });

  const notice = (r: Awaited<ReturnType<typeof rt.runPluginTool>>) => (r.blocks[0] as { type: string; content: string; tone?: string });

  it('runs a tool and returns its blocks', async () => {
    const r = await rt.runPluginTool('testkit', 'echo', { text: 'hi' });
    expect(r.blocks).toEqual([{ type: 'text', content: 'hi' }]);
  });

  it('explains unknown plugins and tools', async () => {
    expect(notice(await rt.runPluginTool('nope', 'x', {})).content).toMatch(/Unknown plugin/);
    expect(notice(await rt.runPluginTool('testkit', 'nope', {})).content).toMatch(/has no tool/);
  });

  it('checks required inputs before running', async () => {
    expect(notice(await rt.runPluginTool('testkit', 'echo', { text: '  ' })).content).toBe('Text is required');
  });

  it('asks for setup instead of running a tool that needs keys', async () => {
    const n = notice(await rt.runPluginTool('testkit', 'secret', {}));
    expect(n.tone).toBe('warn');
    expect(n.content).toMatch(/isn't set up yet/);
  });

  it('turns thrown errors into a readable notice', async () => {
    expect(notice(await rt.runPluginTool('testkit', 'boom', {})).content).toBe('Upstream said no');
  });

  it('times out a tool that never finishes', async () => {
    const t = performance.now();
    const n = notice(await rt.runPluginTool('testkit', 'hang', {}, { timeoutMs: 60 }));
    expect(n.content).toMatch(/Timed out/);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('passes the caller abort through to the tool', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    expect(notice(await rt.runPluginTool('testkit', 'aborts', {}, { signal: ctrl.signal })).content).toBe('aborted by caller');
  });
});

describe('your own plugins (~/.glogg/plugins)', () => {
  const userDir = path.join(home, 'plugins');

  beforeAll(async () => {
    fs.mkdirSync(path.join(userDir, 'hello'), { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'hello', 'index.mjs'),
      `export default {
        id: 'hello', name: 'Hello', description: 'A plugin written outside the repo', category: 'utility',
        tools: [{ id: 'greet', name: 'Greet', description: 'Says hello', trigger: 'hello', inputs: [{ key: 'name', label: 'Name' }],
          run: async (input) => ({ blocks: [{ type: 'text', content: 'Hello, ' + (input.name || 'you') }] }) }],
      };`
    );
    fs.mkdirSync(path.join(userDir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'broken', 'index.mjs'), 'export default { id: "broken", tools: [ }');
    fs.mkdirSync(path.join(userDir, '_draft'), { recursive: true });
    fs.writeFileSync(path.join(userDir, '_draft', 'index.mjs'), 'throw new Error("drafts are ignored")');
    await rt.loadPlugins({ force: true });
  });

  it('loads them next to the built-ins and runs their tools', async () => {
    const hello = rt.listPlugins().find((p) => p.id === 'hello');
    expect(hello).toMatchObject({ source: 'user', configured: true });
    const r = await rt.runPluginTool('hello', 'greet', { name: 'glogg' });
    expect(r.blocks).toEqual([{ type: 'text', content: 'Hello, glogg' }]);
  });

  it('reports a broken plugin by folder name without taking the others down', () => {
    const all = rt.listPlugins();
    const broken = all.find((p) => p.id === 'broken');
    expect(broken?.error).toBeTruthy();
    expect(broken?.error).not.toBe('[object Object]');
    expect(builtins.every((b) => all.some((p) => p.id === b.id && !p.error))).toBe(true);
  });

  it('ignores folders starting with an underscore', () => {
    expect(rt.listPlugins().some((p) => p.id === '_draft')).toBe(false);
  });
});

describe('plugin template', () => {
  it('is a valid plugin whose local tool runs', async () => {
    // @ts-expect-error -- the template is plain JavaScript on purpose, so it can be copied without a build step
    const { default: template } = await import('../plugins/_template/index.mjs');
    expect(rt.validateDefinition(template)).toBeNull();
    rt.registerPlugin({ ...template, id: 'template-check' });
    const r = await rt.runPluginTool('template-check', 'units', { value: 100 });
    expect(r.blocks[0]).toMatchObject({ type: 'kv', items: [{ label: '°C → °F', value: '212.0' }, { label: '°F → °C', value: '37.8' }] });
    rt.unregisterPlugin('template-check');
  });

  it('is skipped by the loader because its folder starts with an underscore', () => {
    expect(rt.listPlugins().some((p) => p.id === 'hello-weather')).toBe(false);
  });
});

describe('download hand-off', () => {
  it('refuses a plugin that is not set up', async () => {
    await expect(rt.sendToPluginTarget('realdebrid', { url: 'magnet:?xt=urn:btih:abc', title: 'x', kind: 'magnet' })).rejects.toThrow(/isn't set up yet/);
  });

  it('refuses link types the plugin does not accept', async () => {
    rt.savePluginSettings('sabnzbd', { apiKey: 'k-123456' });
    await expect(rt.sendToPluginTarget('sabnzbd', { url: 'magnet:?xt=urn:btih:abc', title: 'x', kind: 'magnet' })).rejects.toThrow(/doesn't accept magnet/);
  });

  it('maps download kinds to what plugins accept', () => {
    expect(rt.kindToAccept('magnet')).toBe('magnet');
    expect(rt.kindToAccept('nzb')).toBe('nzb');
    expect(rt.kindToAccept('direct-file')).toBe('link');
    expect(rt.kindToAccept('web-archive')).toBe('link');
  });
});
