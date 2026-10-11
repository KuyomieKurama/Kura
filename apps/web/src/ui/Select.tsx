import { CaretDown, Check } from '@phosphor-icons/react';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useMediaQuery } from '../useMediaQuery.js';
import { Glyph } from './Glyph.js';

export type SelectOption = { value: string; label: string };

const POPUP_MAX = 320;
const POPUP_MIN = 120;
const EDGE = 8;
/** Padding and border of the surface around the list. */
const CHROME = 10;

/**
 * A select with a list of our own (button + listbox), because the list of a native select is drawn by the browser: its
 * place, size and colours cannot be controlled and it showed up far away from the field. From 640px the list opens
 * directly below the button (above it when there is no room), as wide as the button; below 640px it is a bottom sheet.
 * Focus stays on the button; aria-activedescendant names the highlighted row. Arrow keys, Home, End and typeahead
 * move, Enter or Space chooses, Escape closes and keeps the focus on the button, Tab and a click outside close.
 */
export function Select({ label, options, value, onChange, className = 'select-inline' }: {
  /** Accessible name of the button, for example "Abonnement". */
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const popup = useMediaQuery('(min-width: 640px)');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ side: 'below' | 'above'; maxHeight: number }>({ side: 'below', maxHeight: POPUP_MAX });
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const id = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  function openList() {
    setActive(selectedIndex);
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  }

  function choose(index: number) {
    const option = options[index];
    close(true);
    if (option && option.value !== value) onChange(option.value);
  }

  // Popup: below the button if at least 200px fit, else on the side with more room; the height follows the room.
  useLayoutEffect(() => {
    if (!open || !popup) return;
    const measure = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - EDGE - 4;
      const above = rect.top - EDGE - 4;
      const side = below >= 200 || below >= above ? 'below' : 'above';
      const room = side === 'below' ? below : above;
      setPlace((current) => {
        const next = { side, maxHeight: Math.max(POPUP_MIN, Math.min(POPUP_MAX, Math.floor(room) - CHROME)) } as const;
        return current.side === next.side && current.maxHeight === next.maxHeight ? current : next;
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, popup]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  // The highlighted row stays visible in a scrolling list.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = options.length - 1;
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(last, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActive(last);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(active);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typed.current = { text: now - typed.current.at > 700 ? event.key.toLowerCase() : typed.current.text + event.key.toLowerCase(), at: now };
      const match = options.findIndex((option) => option.label.toLowerCase().startsWith(typed.current.text));
      if (match >= 0) setActive(match);
    }
  }

  const surfaceStyle = popup ? { maxHeight: place.maxHeight } : undefined;

  return (
    <div className={`${className} select`} ref={wrapper}>
      <button
        type="button"
        role="combobox"
        className="select-button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        ref={button}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selected?.label ?? ''}</span>
        <span className="select-caret"><Glyph icon={CaretDown} size={16} /></span>
      </button>
      {open && (
        <>
          {!popup && <div className="select-scrim" onPointerDown={() => close(true)} aria-hidden="true" />}
          <div className={popup ? `select-surface select-popup select-popup-${place.side}` : 'select-surface select-sheet'} data-select-surface data-mode={popup ? 'popup' : 'sheet'}>
            {!popup && <div className="select-sheet-title" aria-hidden="true">{label}</div>}
            <div className="select-list" role="listbox" aria-label={label} id={id} ref={list} style={surfaceStyle}>
              {options.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-${index}`}
                  role="option"
                  className="select-option"
                  aria-selected={option.value === value}
                  data-active={index === active ? 'true' : undefined}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(index)}
                >
                  <span className="select-option-label">{option.label}</span>
                  {option.value === value && <Glyph icon={Check} size={16} />}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
