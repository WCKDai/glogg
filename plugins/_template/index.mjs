// glogg plugin template.
//
// Copy this folder to ~/.glogg/plugins/<your-plugin>/ (keep the file name
// index.mjs), change the id, and press Reload on the Tools page. Folders whose
// name starts with "_" are ignored, so this template never loads by itself.
//
// A plugin is a plain object. The UI builds a form from each tool's `inputs`
// and renders the `blocks` your tool returns, so no front-end code is needed.
// Types: src/core/plugins.ts (PluginManifest, OutputBlock) and
// server/plugins/sdk.ts (PluginContext).

export default {
  id: 'hello-weather', // lowercase letters, digits and dashes
  name: 'Weather',
  description: 'Current weather for a place, from Open-Meteo (no key needed).',
  category: 'utility', // search | debrid | storage | usenet | osint | webtest | ai | utility
  icon: 'Cloud', // optional: a lucide icon name; falls back to the category icon
  homepage: 'https://open-meteo.com',

  // Optional. Stored in ~/.glogg/plugins.json (mode 600). `secret: true` values
  // are masked in the browser and only reach your tool through ctx.settings.
  settings: [
    { key: 'units', label: 'Units', type: 'select', default: 'celsius', options: [{ value: 'celsius', label: '°C' }, { value: 'fahrenheit', label: '°F' }] },
  ],

  tools: [
    {
      id: 'now',
      name: 'Weather now',
      description: 'Temperature, wind and conditions for a city.',
      trigger: 'weather', // typing ">weather Copenhagen" runs this tool
      inputs: [{ key: 'place', label: 'Place', required: true, placeholder: 'Copenhagen' }],

      // ctx.fetch / ctx.fetchJson time out on their own and stop when the user
      // cancels; throw an Error with a readable message and glogg shows it.
      async run(input, ctx) {
        const place = String(input.place || '').trim();
        const geo = await ctx.fetchJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(place)}`);
        const hit = geo.results?.[0];
        if (!hit) throw new Error(`No place called "${place}".`);
        const unit = ctx.settings.units === 'fahrenheit' ? 'fahrenheit' : 'celsius';
        const w = await ctx.fetchJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,wind_speed_10m&temperature_unit=${unit}`
        );
        return {
          summary: `${hit.name}: ${w.current.temperature_2m}°`,
          blocks: [
            { type: 'stat', items: [
              { label: 'Temperature', value: `${w.current.temperature_2m}°${unit === 'celsius' ? 'C' : 'F'}` },
              { label: 'Wind', value: `${w.current.wind_speed_10m} km/h` },
            ] },
            { type: 'kv', items: [
              { label: 'Place', value: `${hit.name}, ${hit.country}` },
              { label: 'Coordinates', value: `${hit.latitude}, ${hit.longitude}` },
            ] },
            { type: 'actions', items: [{ label: 'Open map', href: `https://www.openstreetmap.org/?mlat=${hit.latitude}&mlon=${hit.longitude}#map=11/${hit.latitude}/${hit.longitude}` }] },
          ],
        };
      },
    },
    {
      id: 'units',
      name: 'Convert temperature',
      description: 'Celsius ↔ Fahrenheit, locally.',
      inputs: [{ key: 'value', label: 'Degrees', type: 'number', required: true }],
      async run(input) {
        const v = Number(input.value);
        return {
          blocks: [{ type: 'kv', items: [
            { label: '°C → °F', value: ((v * 9) / 5 + 32).toFixed(1) },
            { label: '°F → °C', value: (((v - 32) * 5) / 9).toFixed(1) },
          ] }],
        };
      },
    },
  ],

  // Optional: run a container next to the plugin ($DATA is ~/.glogg/containers/<id>).
  // container: { image: 'ghcr.io/example/app:1.2.3', ports: ['8090:80'], volumes: ['$DATA:/data'], webUrl: 'http://localhost:8090' },

  // Optional: receive magnets / NZBs / links from the Send menu.
  // downloadTarget: { label: 'My service', accepts: ['magnet', 'link'] },
  // async sendDownload(item, ctx) { return { status: 'queued', detail: 'Sent' }; },
};
