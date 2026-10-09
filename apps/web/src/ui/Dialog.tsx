import { X } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useRef } from 'react';
import { labels } from '../labels.js';
import { Button } from './Button.js';

/** Modal dialog. Focus moves into it on open and Escape closes it. */
export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  return (
    <div className="backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} ref={ref}>
        <header className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <Button variant="ghost" icon={X} onClick={close}>{labels.close}</Button>
        </header>
        {children}
      </div>
    </div>
  );
}
