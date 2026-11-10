/**
 * Headless Chrome, driven over the DevTools protocol with Node's own WebSocket,
 * so the browser tests need no test-framework dependency. One page per Browser.
 *
 *   CHROME_PATH  the browser to run (otherwise found on this machine)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  return CANDIDATES.find((p) => fs.existsSync(p));
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Listener = (params: Record<string, unknown>) => void;

export class Browser {
  readonly errors: string[] = [];
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Listener>>();

  private constructor(
    private readonly proc: ChildProcess,
    private readonly ws: WebSocket,
    private readonly profile: string
  ) {
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
      }
    });
  }

  static async launch(profileRoot: string): Promise<Browser> {
    const chrome = findChrome();
    if (!chrome) throw new Error('No Chrome or Chromium found; set CHROME_PATH.');
    const profile = fs.mkdtempSync(path.join(profileRoot, 'chrome-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1360,900',
      // CI runners (Ubuntu 24.04) block the namespaces Chrome's sandbox needs; the pages here are our own.
      ...(process.env.CI ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    const proc = spawn(chrome, args, { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let i = 0; i < 150 && !port; i++) {
      if (proc.exitCode !== null) throw new Error(`Chrome exited (${proc.exitCode}) before it was ready.`);
      try {
        port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!port) throw new Error('Chrome did not open its debugging port.');
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome has no page to drive.');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('Could not connect to Chrome.')), { once: true });
    });
    const browser = new Browser(proc, ws, profile);
    await browser.send('Page.enable');
    await browser.send('Runtime.enable');
    browser.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string } };
      browser.errors.push(`uncaught: ${d.exception?.description ?? d.text}`);
    });
    browser.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      const args = p.args as { value?: unknown; description?: string }[];
      browser.errors.push(`console.error: ${args.map((a) => a.value ?? a.description).join(' ')}`);
    });
    return browser;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(fn);
    this.listeners.set(method, set);
    return () => set.delete(fn);
  }

  /** Runs `expression` in the page and returns its (JSON) value; page exceptions are thrown here. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(`In the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  async goto(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.on('Page.loadEventFired', () => {
        off();
        resolve();
      });
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async reload(): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.on('Page.loadEventFired', () => {
        off();
        resolve();
      });
    });
    await this.send('Page.reload');
    await loaded;
  }

  /** Polls `expression` until it is truthy; the error names what never happened. */
  async waitFor<T = unknown>(expression: string, what = expression, timeoutMs = 8000): Promise<T> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      // A DOM node can't cross the protocol by value, so "found" stands in for it.
      const v = await this.eval<T>(`(() => { const v = (${expression}); return v instanceof Node ? true : v; })()`).catch(() => undefined);
      if (v) return v;
      if (Date.now() > until) {
        const text = await this.eval<string>('document.body ? document.body.innerText.slice(0, 600) : ""').catch(() => '');
        throw new Error(`Timed out waiting for ${what}.\nPage text: ${text}\nPage errors: ${this.errors.join(' | ') || 'none'}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** A real mouse click at the centre of the first element matching `selector`. */
  async click(selector: string): Promise<void> {
    const box = await this.waitFor<{ x: number; y: number }>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
      `a visible ${selector}`
    );
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }

  /** Types into whatever has focus, as an IME would: one input event per call. */
  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  /** Presses a key. `modifiers` is the DevTools bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  async press(key: string, modifiers = 0): Promise<void> {
    const named: Record<string, { code: string; keyCode: number; text?: string }> = {
      Enter: { code: 'Enter', keyCode: 13, text: '\r' },
      Escape: { code: 'Escape', keyCode: 27 },
      ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 },
      Tab: { code: 'Tab', keyCode: 9 },
      '?': { code: 'Slash', keyCode: 191, text: '?' },
      '/': { code: 'Slash', keyCode: 191, text: '/' },
    };
    const k = named[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: modifiers & 6 ? undefined : key };
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async viewport(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  }

  async colorScheme(value: 'light' | 'dark'): Promise<void> {
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  }

  async screenshot(file: string): Promise<void> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  async close(): Promise<void> {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
    if (this.proc.exitCode === null) {
      const exited = new Promise((r) => this.proc.once('exit', r));
      this.proc.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}
