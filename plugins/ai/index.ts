import { AI_PROVIDERS, completeChat, resolveAiConfig } from '../../server/ai.js';
import { definePlugin, fail, str } from '../../server/plugins/sdk.js';

// This plugin holds the BYOK settings used by Research (Advanced view).
// Without a provider, Research still works in extractive mode.
export default definePlugin({
  id: 'ai',
  name: 'AI (bring your own key)',
  description: 'Powers Research answers. Use a local model (Ollama, LM Studio) or any API key — it stays on this machine.',
  category: 'ai',
  icon: 'Sparkles',
  settings: [
    {
      key: 'provider',
      label: 'Provider',
      type: 'select',
      default: 'none',
      options: [{ value: 'none', label: 'Off (extractive answers only)' }, ...Object.entries(AI_PROVIDERS).map(([value, p]) => ({ value, label: p.label }))],
    },
    { key: 'apiKey', label: 'API key', secret: true, help: 'Not needed for Ollama / LM Studio.' },
    { key: 'model', label: 'Model', placeholder: 'Uses the provider default if empty' },
    { key: 'baseUrl', label: 'Base URL', placeholder: 'Override, e.g. http://192.168.1.10:11434/v1' },
  ],
  isConfigured: ({ settings }) => resolveAiConfig(settings) !== null,
  tools: [
    {
      id: 'test',
      name: 'Test connection',
      description: 'Sends a one-line prompt to the configured model.',
      inputs: [],
      requiresSettings: true,
      async run(_i, ctx) {
        const cfg = resolveAiConfig(ctx.settings) || fail('Pick a provider (and key) first.');
        const t = performance.now();
        const reply = await completeChat(cfg, [{ role: 'user', content: 'Reply with exactly: glogg ok' }], { signal: ctx.signal, maxTokens: 20 });
        return {
          summary: `${cfg.model} replied in ${Math.round(performance.now() - t)} ms`,
          blocks: [
            { type: 'notice', tone: 'ok', content: `${AI_PROVIDERS[cfg.provider]?.label ?? cfg.provider} · ${cfg.model} · ${Math.round(performance.now() - t)} ms` },
            { type: 'text', content: reply.trim() },
          ],
        };
      },
    },
    {
      id: 'ask',
      name: 'Ask (no web)',
      description: 'Plain chat with your model. For cited answers from the web, use Research.',
      trigger: 'ai',
      requiresSettings: true,
      inputs: [{ key: 'prompt', label: 'Prompt', type: 'textarea', required: true }],
      async run(input, ctx) {
        const cfg = resolveAiConfig(ctx.settings) || fail('Pick a provider (and key) first.');
        const reply = await completeChat(
          cfg,
          [
            { role: 'system', content: 'Be direct and concise. No moralising, no disclaimers unless safety-critical.' },
            { role: 'user', content: str(input, 'prompt') },
          ],
          { signal: ctx.signal }
        );
        return { blocks: [{ type: 'text', content: reply.trim() }] };
      },
    },
  ],
});
