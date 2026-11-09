/**
 * glogg plugin contract — shared by server, client and plugin authors.
 *
 * A plugin is a folder: `plugins/<id>/index.ts` (or `~/.glogg/plugins/<id>/index.{ts,js,mjs}`)
 * that default-exports `definePlugin({...})`. Plugins declare tools; the UI renders
 * a form from each tool's `inputs` and renders the returned `blocks`. No client
 * code is needed to add a tool.
 */

export type PluginCategory =
  | 'search'
  | 'debrid'
  | 'storage'
  | 'usenet'
  | 'osint'
  | 'webtest'
  | 'ai'
  | 'utility';

export const PLUGIN_CATEGORY_LABELS: Record<PluginCategory, string> = {
  search: 'Search',
  debrid: 'Debrid',
  storage: 'Cloud storage',
  usenet: 'Usenet',
  osint: 'OSINT',
  webtest: 'Website testing',
  ai: 'AI',
  utility: 'Utilities',
};

export interface PluginField {
  key: string;
  label: string;
  type?: 'text' | 'url' | 'textarea' | 'select' | 'number' | 'toggle' | 'password';
  placeholder?: string;
  help?: string;
  required?: boolean;
  /** Settings only: stored server-side, masked when sent to the browser. */
  secret?: boolean;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
}

export interface PluginToolDef {
  id: string;
  name: string;
  description: string;
  inputs: PluginField[];
  /**
   * Quick-launch trigger. Typing `>trigger value` in any search box runs this
   * tool with `value` as the first input.
   */
  trigger?: string;
  /** Tool needs the plugin's settings to be filled in. */
  requiresSettings?: boolean;
}

export interface PluginContainerDef {
  image: string;
  /** host:container */
  ports?: string[];
  env?: Record<string, string>;
  volumes?: string[];
  /** URL of the web UI once running. */
  webUrl?: string;
  args?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  category: PluginCategory;
  version?: string;
  /** lucide-react icon name, e.g. "Cloud", "Radar". */
  icon?: string;
  homepage?: string;
  settings?: PluginField[];
  tools: PluginToolDef[];
  container?: PluginContainerDef;
  /** Plugin can receive magnets / NZBs / links from the Send menu. */
  downloadTarget?: { label: string; accepts: ('magnet' | 'torrent' | 'nzb' | 'link')[] };
}

// ── Tool output blocks ──────────────────────────────────────────────────────
export interface OutputAction {
  label: string;
  /** Opens in a new tab. */
  href?: string;
  /** Sends to the download manager (any target). */
  send?: { url: string; title?: string };
  /** Runs another tool: `pluginId/toolId` with inputs. */
  run?: { tool: string; inputs: Record<string, unknown> };
  copy?: string;
}

export type OutputBlock =
  | { type: 'kv'; title?: string; items: { label: string; value: string; href?: string; tone?: Tone }[] }
  | { type: 'table'; title?: string; columns: string[]; rows: (string | number)[][] }
  | {
      type: 'list';
      title?: string;
      items: {
        title: string;
        subtitle?: string;
        href?: string;
        badge?: string;
        tone?: Tone;
        actions?: OutputAction[];
      }[];
    }
  | { type: 'text'; title?: string; content: string }
  | { type: 'code'; title?: string; content: string; language?: string }
  | { type: 'stat'; items: { label: string; value: string; tone?: Tone }[] }
  | { type: 'checks'; title?: string; items: { label: string; pass: boolean | null; detail?: string }[] }
  | { type: 'actions'; items: OutputAction[] }
  | { type: 'notice'; tone?: Tone; content: string };

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export interface ToolResult {
  blocks: OutputBlock[];
  /** Short line shown in history / toasts. */
  summary?: string;
}

// ── API payloads ────────────────────────────────────────────────────────────
export interface PluginInfo extends PluginManifest {
  source: 'builtin' | 'user';
  configured: boolean;
  hasRunner: boolean;
  error?: string;
  /** Saved settings, secrets masked as ••••last4. Present in /api/plugins responses. */
  values?: Record<string, string>;
}

export interface PluginDownloadTargetInfo {
  id: `plugin:${string}`;
  pluginId: string;
  label: string;
  accepts: ('magnet' | 'torrent' | 'nzb' | 'link')[];
  configured: boolean;
}

export interface PluginContainerStatus {
  runtime: 'docker' | 'podman' | 'none';
  state: 'running' | 'stopped' | 'missing' | 'unavailable';
  detail?: string;
}

/** `>trigger rest of input` → { trigger, rest } */
export function parseToolTrigger(q: string): { trigger: string; rest: string } | null {
  const m = q.trim().match(/^>\s*([a-z0-9][\w.-]*)\s*(.*)$/i);
  return m ? { trigger: m[1].toLowerCase(), rest: m[2].trim() } : null;
}
