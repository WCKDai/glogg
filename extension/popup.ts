import { compileSearchQuery } from '../src/core/queryCompiler.js';

const form = document.getElementById('glogg-popup-form') as HTMLFormElement | null;
const input = document.getElementById('glogg-q') as HTMLInputElement | null;
const linksContainer = document.getElementById('glogg-escape-links') as HTMLElement | null;

function renderLinks(rawQuery: string) {
  if (!linksContainer) return;
  const plan = compileSearchQuery(rawQuery || 'sqlite internals', { lens: 'all' });
  linksContainer.replaceChildren();
  for (const esc of plan.escapeUrls.slice(0, 4)) {
    const a = document.createElement('a');
    a.className = 'link-card';
    a.href = esc.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = `${esc.name} ↗`;
    linksContainer.appendChild(a);
  }
}

input?.addEventListener('input', () => {
  renderLinks(input.value);
});

form?.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!input?.value.trim()) return;
  const plan = compileSearchQuery(input.value.trim(), { lens: 'all' });
  window.open(plan.escapeUrls[1].url, '_blank');
});

renderLinks('sqlite internals');
