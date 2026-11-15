import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { BangDefinition, mergeBangs } from '../../core/browser.js';
import type { InstantAnswerPayload } from '../../core/browser.js';
import { useFocusTrap } from '../lib.js';

function evalBasicExpr(s: string): number | null {
  const t = s.match(/\d+(?:\.\d+)?|[+\-*/%^()]/g);
  if (!t || t.join('') !== s.replace(/\s+/g, '')) return null;
  let i = 0;
  const atom = (): number => {
    const k = t[i++];
    if (k === '+' || k === '-') return k === '-' ? -atom() : atom();
    if (k === '(') { const v = add(); if (t[i++] !== ')') throw 0; return v; }
    const n = Number(k);
    if (!Number.isFinite(n)) throw 0;
    return n;
  };
  const pow = (): number => { const b = atom(); return t[i] === '^' ? (i++, b ** pow()) : b; };
  const mul = (): number => {
    let v = pow();
    while (t[i] === '*' || t[i] === '/' || t[i] === '%') {
      const o = t[i++], r = pow();
      if (o !== '*' && r === 0) throw 0;
      v = o === '*' ? v * r : o === '/' ? v / r : v % r;
    }
    return v;
  };
  const add = (): number => { let v = mul(); while (t[i] === '+' || t[i] === '-') v += t[i++] === '+' ? mul() : -mul(); return v; };
  try { const v = add(); return i === t.length && Number.isFinite(v) ? +v.toPrecision(12) : null; } catch { return null; }
}

const mkCalc = (title: string, subtitle: string, directAnswer: string, swatchColor?: string): InstantAnswerPayload => ({
  kind: 'computation', title, subtitle, directAnswer, swatchColor, confidence: 'verified', citations: [],
});

export function quickCalc(raw: string): InstantAnswerPayload | null {
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = (hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1]).toLowerCase(), n = parseInt(h, 16);
    return mkCalc(`#${h}`, 'Color', `#${h} · rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`, `#${h}`);
  }
  const base = raw.match(/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)\s+(?:in|to)\s+(hex|bin|binary|dec|decimal|oct)$/i);
  if (base && Number.isSafeInteger(+base[1])) {
    const v = +base[1], k = base[2].toLowerCase();
    return mkCalc(raw, 'Base', k === 'hex' ? `0x${v.toString(16)}` : k[0] === 'b' ? `0b${v.toString(2)}` : k === 'oct' ? `0o${v.toString(8)}` : `${v}`);
  }
  const pct = raw.match(/^(-?\d+(?:\.\d+)?)%\s+of\s+(-?\d+(?:\.\d+)?)$/i);
  if (pct) return mkCalc(raw, 'Percentage', `${+((+pct[1] / 100) * +pct[2]).toPrecision(12)}`);
  if (/^[\d\s.+\-*/%^()]+$/.test(raw) && /[+\-*/%^]/.test(raw) && /\d/.test(raw) && raw.length <= 64) {
    const v = evalBasicExpr(raw);
    if (v !== null) return mkCalc(raw, 'Math', `${v}`);
  }
  return null;
}

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

export function CommandPalette({
  commands,
  customBangs,
  onSearch,
  onClose,
}: {
  commands: PaletteCommand[];
  customBangs: BangDefinition[];
  onSearch: (q: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const box = useFocusTrap<HTMLDivElement>();

  useEffect(() => inputRef.current?.focus(), []);
  // Escape closes it wherever focus has gone, not only from its input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = useMemo<PaletteCommand[]>(() => {
    const raw = text.trim();
    const t = raw.toLowerCase();
    const out: PaletteCommand[] = [];
    if (raw) {
      const calc = quickCalc(raw);
      if (calc) {
        out.push({
          id: 'calc',
          label: `= ${calc.directAnswer}`,
          group: 'Instant answer',
          hint: `Copy · ${calc.subtitle || calc.title}`,
          run: () => void navigator.clipboard?.writeText(calc.directAnswer),
        });
      }
      out.push({
        id: 'search',
        label: `Search “${raw}”`,
        group: 'Search',
        run: () => onSearch(raw),
      });
    }
    const bangMatch = t.match(/^!([a-z0-9._-]*)\s*(.*)$/);
    if (bangMatch) {
      const [, prefix, rest] = bangMatch;
      mergeBangs(customBangs)
        .filter((b) => b.trigger.startsWith(prefix) || b.name.toLowerCase().includes(prefix))
        .slice(0, 8)
        .forEach((b) =>
          out.push({
            id: `bang-${b.trigger}`,
            label: `!${b.trigger}  ${b.name}`,
            group: 'Jump to',
            hint: rest ? `“${rest}”` : 'type a query after the bang',
            run: () => onSearch(`!${b.trigger} ${rest}`.trim()),
          })
        );
      return out;
    }
    const filtered = t
      ? commands.filter((c) => `${c.label} ${c.group} ${c.keywords || ''}`.toLowerCase().includes(t))
      : commands;
    // Each group once, in the order the groups first appear.
    const groups = [...new Set(filtered.map((c) => c.group))];
    return [...out, ...groups.flatMap((g) => filtered.filter((c) => c.group === g))];
  }, [text, commands, customBangs, onSearch]);

  useEffect(() => setHi(0), [text]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const run = (c?: PaletteCommand) => {
    if (!c) return;
    onClose();
    c.run();
  };

  let lastGroup = '';
  return (
    <>
      <div className="scrim scrim-soft" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={box}>
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Search or type a command"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[hi] ? `palette-${items[hi].id}` : undefined}
            placeholder="Search, jump with !bang, or run a command…"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHi((h) => Math.min(h + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(items[hi]);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="palette-list" ref={listRef} role="listbox" id="palette-list" aria-label="Commands">
          {items.length === 0 && <li className="palette-empty">Nothing matches.</li>}
          {items.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <React.Fragment key={c.id}>
                {header && (
                  <li className="palette-group" role="presentation">
                    {header}
                  </li>
                )}
                <li
                  id={`palette-${c.id}`}
                  role="option"
                  aria-selected={i === hi}
                  className={i === hi ? 'active' : ''}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(c);
                  }}
                >
                  <span>{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                  {i === hi && <ArrowRight size={13} className="palette-go" />}
                </li>
              </React.Fragment>
            );
          })}
        </ul>
      </div>
    </>
  );
}
