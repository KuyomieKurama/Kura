import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react';

export type TabItem = { id: string; label: string; count?: number };

/**
 * Tabs with a roving tabindex: arrow keys, Home and End move between them. The selected tab has the same width as
 * the others (the weight is reserved by a hidden bold copy), so nothing jumps.
 */
export function Tabs({ tabs, selected, onSelect, label, children }: {
  tabs: TabItem[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
  children: ReactNode;
}) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === selected);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onSelect(target.id);
    refs.current[target.id]?.focus();
  }

  return (
    <div className="tabs">
      <div className="tablist" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === selected}
            aria-controls={`${base}-panel`}
            tabIndex={tab.id === selected ? 0 : -1}
            className="tab"
            ref={(element) => { refs.current[tab.id] = element; }}
            onClick={() => onSelect(tab.id)}
          >
            <span className="tab-label" data-text={tab.label}>{tab.label}</span>
            {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${selected}`} tabIndex={-1} className="tabpanel">
        {children}
      </div>
    </div>
  );
}
