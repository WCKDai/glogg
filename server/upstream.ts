/** Bounds decoded upstream bodies before JSON/XML/HTML parsing. */
export const MAX_UPSTREAM_BYTES = 2_000_000;

const deadlines = new WeakMap<Response, () => void>();

/** Keep the deadline alive through body consumption, and clear it on completion. */
export async function fetchUpstream(url: string | URL, init: RequestInit = {}, timeoutMs = 4200, errorBodies: readonly number[] = []): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const clear = () => { clearTimeout(timer); signal.removeEventListener('abort', clear); };
  signal.addEventListener('abort', clear, { once: true });
  try {
    const response = await fetch(url, { ...init, signal });
    deadlines.set(response, clear);
    // Unused error pages must not outlive the producer's capacity permit.
    if (!response.ok && !errorBodies.includes(response.status)) await discardUpstream(response);
    return response;
  } catch (error) {
    clear();
    throw error;
  }
}

export async function discardUpstream(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
  deadlines.get(response)?.();
  deadlines.delete(response);
}

export async function readUpstreamText(response: Response, maxBytes = MAX_UPSTREAM_BYTES): Promise<string> {
  if (!response.body) { deadlines.get(response)?.(); deadlines.delete(response); return ''; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Upstream response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    // Also closes oversized chunked responses, which may not have Content-Length.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    deadlines.get(response)?.();
    deadlines.delete(response);
  }
}

export async function readUpstreamJson<T = unknown>(response: Response): Promise<T> {
  return JSON.parse(await readUpstreamText(response)) as T;
}
