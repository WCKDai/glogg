/**
 * The LLM client against a model server on 127.0.0.1: how it picks a provider,
 * the requests it sends to OpenAI-compatible APIs and to Anthropic, streamed
 * answers split at any byte, error answers, dropped connections and aborts.
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AI_PROVIDERS, completeChat, resolveAiConfig, streamChat } from '../server/ai.js';
import type { AiConfig, ChatMessage } from '../server/ai.js';

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Reply {
  status?: number;
  type?: string;
  chunks?: (string | Buffer)[];
  /** After the chunks: end the answer (default), cut the connection, or leave it open. */
  then?: 'end' | 'cut' | 'hold';
}

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A model server that records each request and answers it chunk by chunk, a moment apart. */
async function modelServer(reply: (req: Seen) => Reply = () => ({})) {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  let closed = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const entry = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body };
    seen.push(entry);
    res.on('close', () => closed++);
    const r = reply(entry);
    res.writeHead(r.status ?? 200, { 'Content-Type': r.type ?? 'text/event-stream' });
    res.flushHeaders();
    for (const chunk of r.chunks ?? []) {
      res.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    if (r.then === 'cut') res.socket?.destroy();
    else if (r.then !== 'hold') res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  servers.push({ close });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, closedResponses: () => closed };
}

const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const openaiDelta = (content: string) => sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const anthropicEvent = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const textDelta = (text: string) => anthropicEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });

const user = (content: string): ChatMessage => ({ role: 'user', content });

async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) pieces.push(piece);
  return pieces;
}

describe('choosing a provider', () => {
  it('needs a provider, and a key for the ones that charge', () => {
    expect(resolveAiConfig({})).toBeNull();
    expect(resolveAiConfig({ provider: 'none', apiKey: 'sk-1' })).toBeNull();
    for (const provider of ['openai', 'anthropic', 'openrouter', 'groq', 'mistral', 'deepseek', 'together']) {
      expect(resolveAiConfig({ provider }), provider).toBeNull();
      expect(resolveAiConfig({ provider, apiKey: 'sk-1' }), provider).toEqual({
        provider,
        baseUrl: AI_PROVIDERS[provider].baseUrl,
        apiKey: 'sk-1',
        model: AI_PROVIDERS[provider].model,
      });
    }
  });

  it('runs local models without a key, at the address and with the model you give it', () => {
    expect(resolveAiConfig({ provider: 'ollama' })).toEqual({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: AI_PROVIDERS.ollama.model });
    expect(resolveAiConfig({ provider: 'lmstudio' })).toMatchObject({ baseUrl: 'http://localhost:1234/v1', apiKey: '' });
    expect(resolveAiConfig({ provider: 'ollama', baseUrl: 'http://gpu-box.lan:11434/v1///', model: 'qwen3:8b' })).toEqual({
      provider: 'ollama',
      baseUrl: 'http://gpu-box.lan:11434/v1',
      apiKey: '',
      model: 'qwen3:8b',
    });
  });

  it('treats a provider it does not know as a custom OpenAI-compatible server, which needs an address and a model', () => {
    expect(resolveAiConfig({ provider: 'custom' })).toBeNull();
    expect(resolveAiConfig({ provider: 'custom', baseUrl: 'http://vllm.lan:8000/v1' })).toBeNull();
    expect(resolveAiConfig({ provider: 'custom', model: 'llama' })).toBeNull();
    expect(resolveAiConfig({ provider: 'my-vllm', baseUrl: 'http://vllm.lan:8000/v1/', model: 'llama' })).toEqual({
      provider: 'my-vllm',
      baseUrl: 'http://vllm.lan:8000/v1',
      apiKey: '',
      model: 'llama',
    });
  });
});

describe('OpenAI-compatible APIs', () => {
  const conversation: ChatMessage[] = [
    { role: 'system', content: 'Be brief.' },
    user('Say hello'),
    { role: 'assistant', content: 'Hi?' },
    user('Again, louder'),
  ];

  it('posts the whole conversation to /chat/completions with the key and the model, asking for a stream', async () => {
    const srv = await modelServer(() => ({ chunks: [sse({ choices: [{ index: 0, delta: { role: 'assistant' } }] }), openaiDelta('HEL'), openaiDelta('LO'), sse('[DONE]')] }));
    const cfg: AiConfig = { provider: 'openai', baseUrl: `${srv.url}/v1`, apiKey: 'sk-test-123', model: 'gpt-4o-mini' };
    expect(await completeChat(cfg, conversation)).toBe('HELLO');

    expect(srv.seen).toHaveLength(1);
    const [req] = srv.seen;
    expect([req.method, req.path]).toEqual(['POST', '/v1/chat/completions']);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.authorization).toBe('Bearer sk-test-123');
    expect(req.headers['x-api-key']).toBeUndefined();
    expect(req.headers['http-referer']).toBeUndefined();
    expect(JSON.parse(req.body)).toEqual({ model: 'gpt-4o-mini', messages: conversation, max_tokens: 1500, temperature: 0.2, stream: true });
  });

  it('sends the token limit and temperature it is given', async () => {
    const srv = await modelServer(() => ({ chunks: [openaiDelta('ok'), sse('[DONE]')] }));
    const cfg: AiConfig = { provider: 'groq', baseUrl: srv.url, apiKey: 'gsk-1', model: 'llama-3.3-70b-versatile' };
    expect(await collect(streamChat(cfg, [user('hi')], { maxTokens: 64, temperature: 0.7 }))).toEqual(['ok']);
    expect(await completeChat(cfg, [user('hi')], { maxTokens: 20 })).toBe('ok');
    expect(srv.seen.map((r) => JSON.parse(r.body)).map((b) => [b.max_tokens, b.temperature])).toEqual([
      [64, 0.7],
      [20, 0.2],
    ]);
  });

  it('sends no Authorization header to a server that needs no key', async () => {
    const srv = await modelServer(() => ({ chunks: [openaiDelta('local'), sse('[DONE]')] }));
    expect(await completeChat({ provider: 'ollama', baseUrl: `${srv.url}/v1`, apiKey: '', model: 'llama3.1' }, [user('hi')])).toBe('local');
    expect(srv.seen[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(srv.seen[0].body).model).toBe('llama3.1');
  });

  it('names glogg to OpenRouter', async () => {
    const srv = await modelServer(() => ({ chunks: [openaiDelta('routed'), sse('[DONE]')] }));
    await completeChat({ provider: 'openrouter', baseUrl: `${srv.url}/api/v1`, apiKey: 'sk-or-1', model: 'meta-llama/llama-3.1-70b-instruct' }, [user('hi')]);
    expect(srv.seen[0].path).toBe('/api/v1/chat/completions');
    expect(srv.seen[0].headers).toMatchObject({ authorization: 'Bearer sk-or-1', 'http-referer': 'https://glogg.app', 'x-title': 'glogg' });
  });

  it('yields each piece in order however the stream is cut, past CRLF, keep-alives and a broken line', async () => {
    const stream = Buffer.from(
      [
        ': keep-alive',
        '',
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"content":"Fer"}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"content":"ris "}}]}',
        '',
        'data: {"choices":[{"index":0,"delta":{"content":',
        'data: {"choices":[{"index":0,"delta":{"content":"🦀"}}]}',
        '',
        'event: ignored',
        'data:{"choices":[{"index":0,"delta":{"content":" says hi"}}]}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\r\n')
    );
    const crab = stream.indexOf(Buffer.from('🦀'));
    const cuts = [7, 40, 95, crab + 1, crab + 3, stream.length - 9];
    const chunks = cuts.map((at, i) => stream.subarray(i ? cuts[i - 1] : 0, at)).concat(stream.subarray(cuts[cuts.length - 1]));
    const srv = await modelServer(() => ({ chunks }));
    const cfg: AiConfig = { provider: 'openai', baseUrl: srv.url, apiKey: 'sk-1', model: 'gpt-4o-mini' };
    expect(await collect(streamChat(cfg, [user('hi')]))).toEqual(['Fer', 'ris ', '🦀', ' says hi']);
  });

  it('stops at [DONE], even while the server keeps the stream open', async () => {
    const srv = await modelServer(() => ({ chunks: [openaiDelta('done'), sse('[DONE]'), openaiDelta(' and more')], then: 'hold' }));
    expect(await completeChat({ provider: 'openai', baseUrl: srv.url, apiKey: 'sk-1', model: 'm' }, [user('hi')])).toBe('done');
  });

  it('returns what it got when the stream ends without [DONE]', async () => {
    const srv = await modelServer(() => ({ chunks: [openaiDelta('no '), openaiDelta('marker')] }));
    expect(await completeChat({ provider: 'openai', baseUrl: srv.url, apiKey: 'sk-1', model: 'm' }, [user('hi')])).toBe('no marker');
  });
});

describe('Anthropic', () => {
  it('posts to /messages with x-api-key and a version, moving the system messages into system', async () => {
    const srv = await modelServer(() => ({ chunks: [textDelta('Hi'), anthropicEvent('message_stop', {})] }));
    const cfg: AiConfig = { provider: 'anthropic', baseUrl: `${srv.url}/v1`, apiKey: 'sk-ant-123', model: 'claude-3-5-haiku-latest' };
    const messages: ChatMessage[] = [{ role: 'system', content: 'Be brief.' }, user('Hello'), { role: 'assistant', content: 'Hi' }, { role: 'system', content: 'Cite sources.' }, user('Why?')];
    expect(await completeChat(cfg, messages, { maxTokens: 300 })).toBe('Hi');

    const [req] = srv.seen;
    expect([req.method, req.path]).toEqual(['POST', '/v1/messages']);
    expect(req.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'sk-ant-123', 'anthropic-version': '2023-06-01' });
    expect(req.headers.authorization).toBeUndefined();
    expect(JSON.parse(req.body)).toEqual({
      model: 'claude-3-5-haiku-latest',
      system: 'Be brief.\n\nCite sources.',
      messages: [user('Hello'), { role: 'assistant', content: 'Hi' }, user('Why?')],
      max_tokens: 300,
      temperature: 0.2,
      stream: true,
    });
  });

  it('yields only the text deltas of its event stream', async () => {
    const srv = await modelServer(() => ({
      chunks: [
        anthropicEvent('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-3-5-haiku-latest', content: [], usage: { input_tokens: 12, output_tokens: 1 } } }),
        anthropicEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        anthropicEvent('ping', {}),
        textDelta('Hello'),
        anthropicEvent('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"query": "glogg' } }),
        sse({ choices: [{ delta: { content: 'not Anthropic' } }] }),
        textDelta(', world'),
        anthropicEvent('content_block_stop', { index: 0 }),
        anthropicEvent('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }),
        anthropicEvent('message_stop', {}),
      ],
    }));
    const cfg: AiConfig = { provider: 'anthropic', baseUrl: srv.url, apiKey: 'sk-ant-1', model: 'claude-3-5-haiku-latest' };
    expect(await collect(streamChat(cfg, [user('hi')]))).toEqual(['Hello', ', world']);
  });
});

describe('errors', () => {
  it.each([
    ['OpenAI', 'openai', 401, '{"error":{"message":"Incorrect API key provided: sk-test***","type":"invalid_request_error","code":"invalid_api_key"}}', 'OpenAI: Incorrect API key provided: sk-test***'],
    ['Anthropic', 'anthropic', 529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'Anthropic: Overloaded'],
    ['Ollama', 'ollama', 404, '{"error":"model \\"llama3.1\\" not found, try pulling it first"}', 'Ollama (local): model "llama3.1" not found, try pulling it first'],
    ['Groq behind a proxy', 'groq', 502, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'Groq: <html><body><h1>502 Bad Gateway</h1></body></html>'],
    ['DeepSeek, at length', 'deepseek', 500, 'x'.repeat(1000), `DeepSeek: ${'x'.repeat(300)}`],
    ['Mistral, with no body', 'mistral', 503, '', 'Mistral: HTTP 503'],
    ['a custom server', 'my-vllm', 500, '{"detail":"CUDA out of memory"}', 'my-vllm: {"detail":"CUDA out of memory"}'],
  ])('throws what %s says when it refuses', async (_name, provider, status, body, message) => {
    const srv = await modelServer(() => ({ status, type: body.startsWith('{') ? 'application/json' : 'text/html', chunks: body ? [body] : [] }));
    const cfg: AiConfig = { provider, baseUrl: srv.url, apiKey: 'sk-1', model: 'm' };
    await expect(completeChat(cfg, [user('hi')])).rejects.toThrow(new Error(message));
  });

  it('throws when a success has no body to stream', async () => {
    const srv = await modelServer(() => ({ status: 204 }));
    await expect(completeChat({ provider: 'openai', baseUrl: srv.url, apiKey: 'sk-1', model: 'm' }, [user('hi')])).rejects.toThrow(new Error('OpenAI: HTTP 204'));
  });

  it('throws when nothing listens at the address', async () => {
    const { url } = await modelServer();
    await servers.pop()!.close();
    await expect(completeChat({ provider: 'lmstudio', baseUrl: url, apiKey: '', model: 'local-model' }, [user('hi')])).rejects.toThrow('fetch failed');
  });

  it('throws mid-answer when the connection drops, after yielding what arrived', async () => {
    const srv = await modelServer(() => ({ chunks: [openaiDelta('Half an ')], then: 'cut' }));
    const pieces: string[] = [];
    await expect(
      (async () => {
        for await (const piece of streamChat({ provider: 'openai', baseUrl: srv.url, apiKey: 'sk-1', model: 'm' }, [user('hi')])) pieces.push(piece);
      })()
    ).rejects.toThrow();
    expect(pieces).toEqual(['Half an ']);
  });
});

describe('aborting', () => {
  it('stops when the caller aborts mid-answer, and closes the connection', async () => {
    const srv = await modelServer(() => ({ chunks: [openaiDelta('first')], then: 'hold' }));
    const ctrl = new AbortController();
    const pieces: string[] = [];
    const reading = (async () => {
      for await (const piece of streamChat({ provider: 'openai', baseUrl: srv.url, apiKey: 'sk-1', model: 'm' }, [user('hi')], { signal: ctrl.signal })) {
        pieces.push(piece);
        ctrl.abort();
      }
    })();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(pieces).toEqual(['first']);
    await expect.poll(() => srv.closedResponses()).toBe(1);
  });

  it('sends nothing when it was aborted before it started', async () => {
    const srv = await modelServer();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(completeChat({ provider: 'anthropic', baseUrl: srv.url, apiKey: 'sk-ant-1', model: 'm' }, [user('hi')], { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(srv.seen).toEqual([]);
  });
});
