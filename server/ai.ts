/**
 * BYOK LLM client. One OpenAI-compatible path covers OpenAI, OpenRouter, Groq,
 * Mistral, DeepSeek, Together, Ollama and LM Studio; Anthropic gets its own path.
 * Keys never leave the server.
 */
export interface AiConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const AI_PROVIDERS: Record<string, { label: string; baseUrl: string; model: string; needsKey: boolean }> = {
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', needsKey: false },
  lmstudio: { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: 'local-model', needsKey: false },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-haiku-latest', needsKey: true },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-70b-instruct', needsKey: true },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', needsKey: true },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  together: { label: 'Together', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', needsKey: true },
  custom: { label: 'Custom (OpenAI-compatible)', baseUrl: '', model: '', needsKey: false },
};

export function resolveAiConfig(settings: Record<string, string>): AiConfig | null {
  const provider = settings.provider || 'none';
  if (provider === 'none') return null;
  const preset = AI_PROVIDERS[provider] || AI_PROVIDERS.custom;
  const cfg: AiConfig = {
    provider,
    baseUrl: (settings.baseUrl || preset.baseUrl).replace(/\/+$/, ''),
    apiKey: settings.apiKey || '',
    model: settings.model || preset.model,
  };
  if (!cfg.baseUrl || !cfg.model) return null;
  if (preset.needsKey && !cfg.apiKey) return null;
  return cfg;
}

/** Streams text deltas. Throws with a readable message on HTTP errors. */
export async function* streamChat(
  cfg: AiConfig,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; maxTokens?: number; temperature?: number } = {}
): AsyncGenerator<string> {
  const isAnthropic = cfg.provider === 'anthropic';
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');

  const res = await fetch(isAnthropic ? `${cfg.baseUrl}/messages` : `${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    signal: opts.signal,
    headers: isAnthropic
      ? { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
      : {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...(cfg.provider === 'openrouter' ? { 'HTTP-Referer': 'https://glogg.app', 'X-Title': 'glogg' } : {}),
        },
    body: JSON.stringify(
      isAnthropic
        ? { model: cfg.model, system, messages: rest, max_tokens: opts.maxTokens ?? 1500, temperature: opts.temperature ?? 0.2, stream: true }
        : { model: cfg.model, messages, max_tokens: opts.maxTokens ?? 1500, temperature: opts.temperature ?? 0.2, stream: true }
    ),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      msg = typeof j.error === 'string' ? j.error : j.error?.message || msg;
    } catch {
      // not JSON
    }
    throw new Error(`${AI_PROVIDERS[cfg.provider]?.label || cfg.provider}: ${msg || `HTTP ${res.status}`}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          type?: string;
          delta?: { text?: string };
        };
        const piece = isAnthropic ? (j.type === 'content_block_delta' ? j.delta?.text : undefined) : j.choices?.[0]?.delta?.content;
        if (piece) yield piece;
      } catch {
        // partial / keep-alive line
      }
    }
  }
}

export async function completeChat(cfg: AiConfig, messages: ChatMessage[], opts: { signal?: AbortSignal; maxTokens?: number } = {}): Promise<string> {
  let out = '';
  for await (const piece of streamChat(cfg, messages, opts)) out += piece;
  return out;
}
