// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { scoreSearchResult } from '../src/core/index.js';
import { quickCalc } from '../src/client/components/CommandPalette.js';
import { AnswerCard, ResultItem, renderHighlightedSnippet } from '../src/client/components/Results.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('0.5.0 client quickCalc, snippet highlighting & result/answer UI', () => {
  it('computes 0ms client previews in quickCalc and escapes markup while highlighting snippet matches', () => {
    expect(quickCalc('12 * 8')?.directAnswer).toBe('96');
    expect(quickCalc('25% of 80')?.directAnswer).toBe('20');
    expect(quickCalc('#336699')?.swatchColor).toBe('#336699');
    expect(quickCalc('255 in hex')?.directAnswer).toBe('0xff');
    expect(quickCalc('rust borrow checker')).toBeNull();

    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <div>
          <p className="snip">{renderHighlightedSnippet('SQLite <script>alert(1)</script> uses WAL mode', 'sqlite -mysql site:sqlite.org')}</p>
          <AnswerCard
            answer={{
              kind: 'computation',
              title: '#ff5733',
              subtitle: 'Color',
              directAnswer: '#ff5733 · rgb(255, 87, 51)',
              swatchColor: '#ff5733',
              confidence: 'verified',
              citations: [],
            }}
            onRead={() => {}}
          />
          <ResultItem
            item={scoreSearchResult({
              id: 'r1',
              title: 'SQLite WAL Mode',
              url: 'https://sqlite.org/wal.html',
              snippet: 'Write-Ahead Logging in SQLite.',
              source: 'marginalia',
            })}
            active={false}
            onHover={() => {}}
            saved={false}
            onSave={() => {}}
            onRead={() => {}}
            onSend={() => {}}
            onRule={() => {}}
            onSiteSearch={() => {}}
            query="sqlite wal"
          />
        </div>
      );
    });

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelectorAll('mark.hl').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('i.answer-swatch')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('.answer-eyebrow span')).map((el) => el.textContent)).toEqual(['Calculated']);

    act(() => root.unmount());
  });
});
