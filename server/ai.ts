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

type StreamEvent = {
  choices?: { delta?: { content?: string } }[];
  type?: string;
  delta?: { text?: string };
  error?: { message?: string } | string;
};

type WholeReply = {
  choices?: { message?: { content?: unknown } }[];
  content?: { type?: string; text?: unknown }[];
  error?: { message?: string } | string;
};

/** [DONE]: a symbol, since a model may well answer with the word "done". */
const DONE = Symbol('done');

function errorText(error: { message?: string } | string, fallback: string): string {
  return (typeof error === 'string' ? error : error.message) || fallback;
}

/**
 * Streams text deltas. Throws with a readable message on HTTP errors, when the provider reports one
 * partway, and when the answer is empty, so callers can fall back instead of showing nothing.
 */
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
  /** The body so far, kept until a `data:` line shows it is an event stream. */
  let whole = '';
  let streaming = false;
  let wrote = false;
  /** The text one line of the event stream carries, or DONE at [DONE]. */
  const read = (raw: string): string | typeof DONE | undefined => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return undefined;
    streaming = true;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return DONE;
    let j: StreamEvent;
    try {
      j = JSON.parse(payload);
    } catch {
      return undefined; // partial / keep-alive line
    }
    if (!j || typeof j !== 'object') return undefined;
    // Anthropic's `error` event (overloaded, say) and OpenRouter's `error` field end the answer early: that's a failure, not a finished answer.
    if (j.error) throw new Error(errorText(j.error, 'The answer stopped with an error'));
    const piece = isAnthropic ? (j.type === 'content_block_delta' ? j.delta?.text : undefined) : j.choices?.[0]?.delta?.content;
    return typeof piece === 'string' && piece ? piece : undefined;
  };
  reading: for (;;) {
    const { done, value } = await reader.read();
    const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
    buf += chunk;
    if (!streaming) whole += chunk;
    const lines = buf.split('\n');
    // A stream may end without a newline after its last event.
    buf = done ? '' : lines.pop()!;
    for (const line of lines) {
      const piece = read(line);
      if (piece === DONE) {
        // The server may hold the connection open after [DONE].
        void reader.cancel().catch(() => undefined);
        break reading;
      }
      if (piece) {
        wrote = true;
        yield piece;
      }
    }
    if (done) break;
  }
  if (!streaming) {
    // A server that ignores `stream: true` (some proxies and local servers do) sends the whole reply as JSON.
    let j: WholeReply | undefined;
    try {
      j = JSON.parse(whole) as WholeReply;
    } catch {
      const type = (res.headers.get('content-type') || 'something').split(';')[0].trim();
      throw new Error(`the server sent ${type} instead of an answer`);
    }
    if (j?.error) throw new Error(errorText(j.error, 'The answer was an error'));
    const text = isAnthropic
      ? (Array.isArray(j?.content) ? j.content : []).map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
      : j?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text) {
      yield text;
      return;
    }
  }
  if (!wrote) throw new Error('the answer was empty');
}

export async function completeChat(cfg: AiConfig, messages: ChatMessage[], opts: { signal?: AbortSignal; maxTokens?: number } = {}): Promise<string> {
  let out = '';
  for await (const piece of streamChat(cfg, messages, opts)) out += piece;
  return out;
}
