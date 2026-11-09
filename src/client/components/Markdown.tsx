import React from 'react';

/**
 * Small Markdown renderer for model output and tool text. It builds React
 * elements only (never raw HTML), allows http(s) links only, and turns [n]
 * citations into links to the numbered sources. An unclosed code fence still
 * renders as code, so streamed answers look right mid-stream.
 */
export interface CiteSource {
  index: number;
  title: string;
  url: string;
}

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'p'; text: string };

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;

  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    if (list) blocks.push(list);
    para = [];
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
    } else if (bullet || ordered) {
      const kind = bullet ? 'ul' : 'ol';
      if (para.length || (list && list.kind !== kind)) flush();
      list ??= { kind, items: [] };
      list.items.push((bullet || ordered)![1]);
    } else if (quote) {
      flush();
      blocks.push({ kind: 'quote', text: quote[1] });
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

const INLINE =
  /(`[^`\n]+`)|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\[(\d+(?:\s*[,–-]\s*\d+)*)\](?!\()|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\s][^*\n]*?)\*(?!\w)|(?<!\w)_([^_\s][^_\n]*?)_(?!\w)/g;

function citeNumbers(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split(/[–-]/).map((n) => Number(n.trim()));
    if (b && b > a && b - a < 20) for (let n = a; n <= b; n++) out.push(n);
    else if (a) out.push(a);
  }
  return out;
}

function renderInline(text: string, sources: CiteSource[], key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2])
      out.push(
        <a key={k} href={m[3]} target="_blank" rel="noreferrer noopener">
          {m[2]}
        </a>
      );
    else if (m[4]) {
      const nums = citeNumbers(m[4]);
      const known = nums.map((n) => sources.find((s) => s.index === n));
      if (known.every(Boolean)) {
        out.push(
          <span key={k} className="cites">
            {known.map((s) => (
              <a key={s!.index} className="cite-ref" href={s!.url} target="_blank" rel="noreferrer noopener" title={s!.title}>
                {s!.index}
              </a>
            ))}
          </span>
        );
      } else out.push(m[0]);
    } else if (m[5]) out.push(<strong key={k}>{m[5]}</strong>);
    else if (m[6] || m[7]) out.push(<em key={k}>{m[6] || m[7]}</em>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, sources = [], className = 'md' }: { text: string; sources?: CiteSource[]; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case 'code':
            return (
              <pre key={key}>
                <code>{b.text}</code>
              </pre>
            );
          case 'heading':
            return React.createElement(`h${Math.min(b.level + 2, 6)}`, { key }, renderInline(b.text, sources, key));
          case 'ul':
          case 'ol':
            return React.createElement(
              b.kind,
              { key },
              b.items.map((item, j) => <li key={j}>{renderInline(item, sources, `${key}-${j}`)}</li>)
            );
          case 'quote':
            return <blockquote key={key}>{renderInline(b.text, sources, key)}</blockquote>;
          default:
            return <p key={key}>{renderInline(b.text, sources, key)}</p>;
        }
      })}
    </div>
  );
}
