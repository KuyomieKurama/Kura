import type { Icon } from '@phosphor-icons/react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Glyph } from './Glyph.js';

export type MenuItem = {
  label: string;
  onSelect: () => void;
  icon?: Icon;
  /** Danger text (delete). Always confirmed by a dialog by the caller. */
  tone?: 'danger';
  /** A hairline above the entry. */
  separatorBefore?: boolean;
  disabled?: boolean;
};

/**
 * A menu button with a popover. Arrow keys, Home, End and typeahead move the focus, Escape closes and returns the
 * focus to the button, a click outside closes. Entries are 36px high (44px on touch).
 */
export function Menu({ label, trigger, items, placement = 'bottom-end', triggerClassName = 'btn btn-ghost btn-icon' }: {
  /** Accessible name of the button, for example "Weitere Aktionen für Atelier Mori". */
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  placement?: 'bottom-end' | 'top-start';
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();

  function entries(): HTMLButtonElement[] {
    return Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    entries()[0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const all = entries();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      all[(index + 1) % all.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      all[(index - 1 + all.length) % all.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      all[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      all[all.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typed.current = { text: now - typed.current.at > 700 ? event.key.toLowerCase() : typed.current.text + event.key.toLowerCase(), at: now };
      const match = all.find((entry) => entry.textContent?.trim().toLowerCase().startsWith(typed.current.text));
      match?.focus();
    }
  }

  return (
    <div className="menu" ref={wrapper}>
      <button
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        ref={button}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open && (
        <div className={`popover popover-${placement}`} role="menu" aria-label={label} id={id} ref={list} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <div key={item.label} role="none">
              {item.separatorBefore && <hr className="menu-separator" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                className={item.tone === 'danger' ? 'menu-item menu-item-danger' : 'menu-item'}
                onClick={() => {
                  close(false);
                  item.onSelect();
                }}
              >
                {item.icon && <Glyph icon={item.icon} />}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
