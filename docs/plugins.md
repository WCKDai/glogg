# Writing a glogg plugin

Every tool in glogg is a plugin: a folder with one file. A plugin declares **settings**, **tools** with typed inputs, and optionally a **container** and a **download hand-off**. glogg builds the forms and renders the output, so a plugin needs no front-end code.

## Where plugins live

| Location | For | File |
| :--- | :--- | :--- |
| `~/.glogg/plugins/<id>/` (`/data/plugins/<id>/` in Docker) | Your own plugins; survive updates | `index.mjs`, `index.js` or `index.ts` |
| `plugins/<id>/` in the repository | Built-in plugins shipped with glogg | `index.ts` |

Folders starting with `_` are ignored. After adding or editing a plugin, press **Reload** on the Tools page (or `POST /api/plugins/reload`).

## Five-minute start

```bash
mkdir -p ~/.glogg/plugins
cp -r plugins/_template ~/.glogg/plugins/hello-weather
# edit ~/.glogg/plugins/hello-weather/index.mjs, then press Reload on the Tools page
```

Then type `>weather Copenhagen` in the search box. The [template](../plugins/_template/index.mjs) is a complete, commented example.

## Anatomy

```js
export default {
  id: 'hello-weather',          // lowercase letters, digits, dashes; unique
  name: 'Weather',
  description: 'Current weather for a place.',
  category: 'utility',          // search | debrid | storage | usenet | osint | webtest | ai | utility
  icon: 'Cloud',                // optional lucide icon name
  homepage: 'https://open-meteo.com',

  settings: [ /* fields, see below */ ],

  tools: [
    {
      id: 'now',
      name: 'Weather now',
      description: 'Temperature and wind for a city.',
      trigger: 'weather',       // ">weather <value>" runs it with <value> as the first input
      inputs: [{ key: 'place', label: 'Place', required: true }],
      async run(input, ctx) {
        return { summary: 'Short line for history', blocks: [ /* output, see below */ ] };
      },
    },
  ],
};
```

In the repository, wrap it in `definePlugin({...})` from [`server/plugins/sdk.ts`](../server/plugins/sdk.ts) for types. Outside it, a plain object is enough.

### Fields (settings and inputs)

```ts
{
  key: 'apiKey',
  label: 'API key',
  type: 'text' | 'url' | 'textarea' | 'select' | 'number' | 'toggle' | 'password',
  placeholder?: string,
  help?: string,
  required?: boolean,
  secret?: boolean,            // settings only: stored server-side, masked in the browser
  options?: [{ value, label }],// for select
  default?: string | number | boolean,
}
```

Settings are saved in `~/.glogg/plugins.json` (mode 600). Secret values never reach the browser; your tool sees them in `ctx.settings`. A plugin counts as configured once every `required` setting is filled in (override with `isConfigured(ctx)`).

### The context

```ts
ctx.settings        // this plugin's settings, unmasked (server-side only)
ctx.integrations    // shared config: Offcloud, NZB.life, Nextcloud, aria2…
ctx.signal          // aborted when the tool times out (45 s) or the user cancels
ctx.fetch(url, init?, timeoutMs?)        // fetch with a timeout and ctx.signal
ctx.fetchJson(url, init?, timeoutMs?)    // the same, parsed; throws on non-2xx
ctx.saveSetting(key, value)              // persist e.g. a refreshed token
```

Throw an `Error` with a readable message and glogg shows it to the user. The SDK's helpers (`fail`, `need`, `str`, `bool`, `toHostname`, `toUrl`, `form`, `multipart`, `formatBytes`, `mapLimit`) cover the usual chores.

### Output blocks

A tool returns `{ blocks, summary? }`. Blocks render in order:

| Block | Shape |
| :--- | :--- |
| `stat` | `{ type: 'stat', items: [{ label, value, tone? }] }`: big numbers |
| `kv` | `{ type: 'kv', title?, items: [{ label, value, href?, tone? }] }`: key/value list |
| `table` | `{ type: 'table', title?, columns: string[], rows: (string\|number)[][] }` |
| `list` | `{ type: 'list', title?, items: [{ title, subtitle?, href?, badge?, tone?, actions? }] }` |
| `checks` | `{ type: 'checks', title?, items: [{ label, pass: true\|false\|null, detail? }] }`: pass/fail audits |
| `text` | `{ type: 'text', title?, content }` |
| `code` | `{ type: 'code', title?, content, language? }` |
| `notice` | `{ type: 'notice', tone?, content }` |
| `actions` | `{ type: 'actions', items: OutputAction[] }` |

`tone` is `ok`, `warn`, `bad` or `info`. An `OutputAction` is `{ label }` plus one of:

- `href`: open a link in a new tab;
- `send: { url, title? }`: hand a magnet, NZB or link to the download manager;
- `run: { tool: 'pluginId/toolId', inputs }`: run another tool;
- `copy`: copy text to the clipboard.

Text is rendered as text, never as HTML, so upstream data can't inject markup.

### Receiving downloads

```js
downloadTarget: { label: 'My service', accepts: ['magnet', 'torrent', 'nzb', 'link'] },
async sendDownload(item, ctx) {        // item: { url, title, kind }
  const job = await ctx.fetchJson('https://api.example/add', { method: 'POST', body: item.url });
  return { remoteId: job.id, status: 'queued', detail: 'Added', destinationUrl: job.webUrl };
},
async pollDownload(remoteId, ctx) {     // optional: progress for the Downloads page
  const j = await ctx.fetchJson(`https://api.example/jobs/${remoteId}`);
  return { status: j.done ? 'completed' : 'downloading', progressPercent: j.progress };
},
```

Once configured, the plugin appears in every Send menu.

### Running a container

```js
container: {
  image: 'ghcr.io/example/app:1.2.3',   // pin a version
  ports: ['127.0.0.1:8090:80'],
  volumes: ['$DATA:/data'],             // $DATA is ~/.glogg/containers/<id>
  env: { TZ: 'UTC' },
  webUrl: 'http://localhost:8090',
},
```

The plugin's card then gets Start / Stop buttons (Docker or Podman; off inside glogg's own container).

## Rules for built-in plugins

If you contribute a plugin to the repository:

- Put keys in `settings` with `secret: true`; never log them or return them in blocks.
- Use `ctx.fetch` / `ctx.fetchJson` so timeouts and cancellation work.
- Validate inputs with the SDK helpers and fail with messages a user can act on.
- Add a test to [`tests/pluginTools.test.ts`](../tests/pluginTools.test.ts) that runs offline: stub `fetch` or serve fixtures with `fixtureServer` from `tests/helpers.ts`. Tests can't reach the internet.
- Run `npm run check && npm test` before opening a pull request.
