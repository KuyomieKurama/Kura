import { X } from '@phosphor-icons/react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { labels } from '../labels.js';
import { Glyph } from './Glyph.js';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog (a bottom sheet on narrow screens). The focus moves to the element marked data-autofocus (the safest one,
 * for deleting that is "Abbrechen"), otherwise to the dialog. Tab stays inside, Escape closes, and the focus returns to
 * the element that opened it. The title is the accessible name.
 */
export function Dialog({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current;
    target?.focus();
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  function trap(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref} onKeyDown={trap}>
        <header className="dialog-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={labels.close} onClick={close}>
            <Glyph icon={X} size={18} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
