import React, { forwardRef, useMemo, useState } from 'react';
import { ArrowRight, CornerDownLeft, Search, Wrench, X } from 'lucide-react';
import { BangDefinition, parseToolTrigger, resolveBang, suggestBangs } from '../../core/browser.js';
import { suggestTools } from '../lib.js';
import type { ToolRef } from '../lib.js';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (q: string) => void;
  customBangs: BangDefinition[];
  busy?: boolean;
  size?: 'hero' | 'bar';
  autoFocus?: boolean;
  uncensored?: boolean;
  /** Tools with a `>trigger`, for suggestions. */
  tools?: ToolRef[];
}

export const SearchBox = forwardRef<HTMLInputElement, Props>(function SearchBox(
  { value, onChange, onSubmit, customBangs, busy, size = 'bar', autoFocus, uncensored, tools = [] },
  ref
) {
  const [focused, setFocused] = useState(false);
  const [hi, setHi] = useState(0);
  const toolSuggestions = useMemo(() => (focused ? suggestTools(tools, value) : []), [value, tools, focused]);
  const suggestions = useMemo(
    () => (focused && toolSuggestions.length === 0 ? suggestBangs(value, customBangs, 7) : []),
    [value, customBangs, focused, toolSuggestions.length]
  );
  const pendingBang = useMemo(() => resolveBang(value, customBangs), [value, customBangs]);
  const pendingTool = useMemo(() => {
    const t = parseToolTrigger(value);
    return t ? tools.find((x) => x.tool.trigger === t.trigger) : undefined;
  }, [value, tools]);
  const menuLength = toolSuggestions.length || suggestions.length;

  const applySuggestion = (b: BangDefinition) => {
    onChange(value.replace(/(^|\s)!([a-z0-9._-]*)$/i, `$1!${b.trigger} `));
    setHi(0);
  };

  const applyTool = (t: ToolRef) => {
    onChange(`>${t.tool.trigger} `);
    setHi(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (menuLength > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHi((h) => (h + 1) % menuLength);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((h) => (h - 1 + menuLength) % menuLength);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (toolSuggestions.length) applyTool(toolSuggestions[hi] || toolSuggestions[0]);
        else applySuggestion(suggestions[hi] || suggestions[0]);
        return;
      }
    }
    if (e.key === 'Escape') {
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <form
      className={`searchbox searchbox-${size}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (toolSuggestions.length > 0) {
          // A complete trigger runs straight away unless the tool still needs input.
          const picked = toolSuggestions[hi] || toolSuggestions[0];
          const exact = pendingTool && toolSuggestions.includes(pendingTool) ? pendingTool : undefined;
          if (exact && !exact.tool.inputs.some((f) => f.required)) onSubmit(value);
          else applyTool(exact || picked);
          return;
        }
        if (suggestions.length > 0 && !pendingBang) {
          applySuggestion(suggestions[hi] || suggestions[0]);
          return;
        }
        onSubmit(value);
      }}
    >
      <Search size={size === 'hero' ? 18 : 16} className="searchbox-icon" aria-hidden />
      <input
        ref={ref}
        className="searchbox-input"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setHi(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={onKeyDown}
        placeholder="Search anything, !bang or >tool"
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        aria-label="Search"
      />
      {uncensored && <span className="tag tag-danger">18+</span>}
      {pendingTool ? (
        <span className="searchbox-bang" title={pendingTool.tool.description}>
          <Wrench size={12} /> {pendingTool.tool.name}
        </span>
      ) : pendingBang ? (
        <span className="searchbox-bang" title={pendingBang.url}>
          <ArrowRight size={13} /> {pendingBang.bang.name}
        </span>
      ) : busy ? (
        <span className="spinner" aria-label="Searching" />
      ) : value ? (
        <button type="button" className="icon-btn ghost" onClick={() => onChange('')} aria-label="Clear">
          <X size={15} />
        </button>
      ) : null}

      {toolSuggestions.length > 0 && (
        <ul className="bang-menu" role="listbox" aria-label="Tools">
          {toolSuggestions.map((t, i) => (
            <li
              key={t.key}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                applyTool(t);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="mono">&gt;{t.tool.trigger}</span>
              <span>{t.tool.name}</span>
              <span className="bang-cat">{t.pluginName}</span>
            </li>
          ))}
          <li className="bang-menu-foot">
            <kbd>Tab</kbd> complete <kbd>↵</kbd> run <CornerDownLeft size={11} />
          </li>
        </ul>
      )}

      {suggestions.length > 0 && (
        <ul className="bang-menu" role="listbox">
          {suggestions.map((b, i) => (
            <li
              key={b.trigger}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                applySuggestion(b);
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="mono">!{b.trigger}</span>
              <span>{b.name}</span>
              <span className="bang-cat">{b.category}</span>
            </li>
          ))}
          <li className="bang-menu-foot">
            <kbd>Tab</kbd> complete <kbd>↵</kbd> go <CornerDownLeft size={11} />
          </li>
        </ul>
      )}
    </form>
  );
});
