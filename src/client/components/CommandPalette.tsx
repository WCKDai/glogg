import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import { BangDefinition, mergeBangs } from '../../core/browser.js';
import { useFocusTrap } from '../lib.js';

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

  const items = useMemo<PaletteCommand[]>(() => {
    const t = text.trim().toLowerCase();
    const out: PaletteCommand[] = [];
    if (t) {
      out.push({
        id: 'search',
        label: `Search “${text.trim()}”`,
        group: 'Search',
        run: () => onSearch(text.trim()),
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
              } else if (e.key === 'Escape') {
                onClose();
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
