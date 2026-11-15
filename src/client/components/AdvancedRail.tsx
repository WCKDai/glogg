import { useFeatures } from '../capabilities.js';
import React from 'react';
import { ArrowLeft, Sparkles, Wrench } from 'lucide-react';
import type { ResearchDepth, SearchLensId } from '../../core/browser.js';
import { SCOPES, SOURCE_LABELS } from '../lib.js';
import type { SearchPrefs } from '../views/SettingsView.js';

function RailToggle({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <div className="rail-row" title={hint}>
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch switch-sm ${on ? 'on' : ''}`} onClick={() => set(!on)}>
        <span />
      </button>
    </div>
  );
}

export function AdvancedRail({
  scope,
  onScope,
  sources,
  total,
  sourceFilter,
  onSourceFilter,
  prefs,
  onPrefs,
  researchAuto,
  onResearchAuto,
  researchDepth,
  onResearchDepth,
  aiLabel,
  onSetupAi,
  onOpenTools,
  onSimple,
}: {
  scope: SearchLensId;
  onScope: (s: SearchLensId) => void;
  sources: [string, number][];
  total: number;
  sourceFilter: string | null;
  onSourceFilter: (s: string | null) => void;
  prefs: SearchPrefs;
  onPrefs: (p: SearchPrefs) => void;
  researchAuto: boolean;
  onResearchAuto: (v: boolean) => void;
  researchDepth: ResearchDepth;
  onResearchDepth: (d: ResearchDepth) => void;
  aiLabel: string | null;
  onSetupAi: () => void;
  onOpenTools: () => void;
  onSimple: () => void;
}) {
  const features = useFeatures();
  return (
    <aside className="rail" aria-label="Search controls">
      <button type="button" className="rail-mode" onClick={onSimple} title="Back to the simple view (m)">
        <ArrowLeft size={12} /> Simple view
      </button>
      <section className="rail-section">
        <h2 className="rail-title">Scope</h2>
        <div className="rail-list" role="radiogroup" aria-label="Scope">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={scope === s.id}
              className={`rail-item ${scope === s.id ? 'active' : ''}`}
              onClick={() => onScope(s.id)}
              title={s.hint}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {sources.length > 0 && (
        <section className="rail-section">
          <h2 className="rail-title">Sources</h2>
          <div className="rail-list">
            <button type="button" className={`rail-item ${!sourceFilter ? 'active' : ''}`} onClick={() => onSourceFilter(null)}>
              All <span className="count">{total}</span>
            </button>
            {sources.map(([src, n]) => (
              <button
                key={src}
                type="button"
                className={`rail-item ${sourceFilter === src ? 'active' : ''}`}
                onClick={() => onSourceFilter(sourceFilter === src ? null : src)}
              >
                {SOURCE_LABELS[src] || src} <span className="count">{n}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="rail-section">
        <h2 className="rail-title">Filters</h2>
        <div className="rail-row">
          <span>Per site</span>
          <div className="segmented segmented-sm" role="radiogroup" aria-label="Results per site">
            {[1, 2, 3, 0].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={prefs.maxPerDomain === n}
                className={prefs.maxPerDomain === n ? 'active' : ''}
                onClick={() => onPrefs({ ...prefs, maxPerDomain: n })}
              >
                {n === 0 ? '∞' : n}
              </button>
            ))}
          </div>
        </div>
        <RailToggle label="Hide sponsored" on={prefs.stripSponsored} set={(v) => onPrefs({ ...prefs, stripSponsored: v })} />
        <RailToggle label="Independent only" hint="Skip big platforms" on={prefs.obscureWebOnly} set={(v) => onPrefs({ ...prefs, obscureWebOnly: v })} />
        <RailToggle label="Before ChatGPT" hint="Pages from before Nov 2022" on={prefs.preLlmOnly} set={(v) => onPrefs({ ...prefs, preLlmOnly: v })} />
      </section>

      {features.research && <section className="rail-section">
        <h2 className="rail-title">Research</h2>
        <RailToggle label="Answer every search" on={researchAuto} set={onResearchAuto} />
        <div className="rail-row">
          <span>Depth</span>
          <div className="segmented segmented-sm" role="radiogroup" aria-label="Research depth">
            {(['quick', 'deep'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={researchDepth === d}
                className={researchDepth === d ? 'active' : ''}
                onClick={() => onResearchDepth(d)}
                title={d === 'quick' ? 'Reads 5 pages' : 'Reads 8 pages, longer answers'}
              >
                {d === 'quick' ? 'Quick' : 'Deep'}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="rail-model" onClick={onSetupAi} title="Choose the model that writes answers">
          <Sparkles size={13} />
          <span className="truncate">{aiLabel || 'No model: quotes only'}</span>
        </button>
      </section>}

      {features.tools && <button type="button" className="rail-item rail-tools" onClick={onOpenTools}>
        <Wrench size={13} /> All tools
      </button>}
    </aside>
  );
}
