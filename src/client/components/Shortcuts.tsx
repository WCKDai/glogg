import { useFeatures } from '../capabilities.js';
import React, { useEffect } from 'react';
import { useFocusTrap } from '../lib.js';

/** Every key glogg answers to, one press of "?" away. */
const SHORTCUTS: [keys: string[], what: string][] = [
  [['/'], 'Focus the search box'],
  [['⌘', 'K'], 'Command palette'],
  [['j'], 'Next result'],
  [['k'], 'Previous result'],
  [['↵'], 'Open the result'],
  [['r'], 'Read it clean'],
  [['d'], 'Send to downloads'],
  [['m'], 'Simple or Advanced view'],
  [['?'], 'This list'],
  [['Esc'], 'Close'],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  const features = useFeatures();
  const box = useFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim scrim-soft" onClick={onClose} />
      <div className="palette shortcuts" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" ref={box} tabIndex={-1}>
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <dl>
          {SHORTCUTS.filter(([keys]) => keys[0] !== 'd' || features.downloads).map(([keys, what]) => (
            <div key={what}>
              <dt>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
