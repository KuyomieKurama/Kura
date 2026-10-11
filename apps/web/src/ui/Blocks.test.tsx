// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.js';
import { Menu } from './Menu.js';
import { RelativeTime } from './RelativeTime.js';
import { Switch } from './Switch.js';
import { Tabs } from './Tabs.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Example({ onSelect }: { onSelect: (name: string) => void }) {
  return (
    <Menu
      label="Weitere Aktionen für Atelier"
      trigger="…"
      items={[
        { label: 'Bearbeiten', onSelect: () => onSelect('edit') },
        { label: 'Pausieren', onSelect: () => onSelect('pause') },
        { label: 'Löschen', tone: 'danger', separatorBefore: true, onSelect: () => onSelect('delete') }
      ]}
    />
  );
}

it('menu: opens with Enter, moves with arrows and typeahead, selects, and Escape returns the focus to the button', () => {
  const onSelect = vi.fn();
  render(<Example onSelect={onSelect} />);
  const button = screen.getByRole('button', { name: 'Weitere Aktionen für Atelier' });
  expect(button).toHaveAttribute('aria-haspopup', 'menu');
  expect(button).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(button);
  const items = screen.getAllByRole('menuitem');
  expect(items.map((item) => item.textContent)).toEqual(['Bearbeiten', 'Pausieren', 'Löschen']);
  expect(items[0]).toHaveFocus();
  fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
  expect(items[1]).toHaveFocus();
  fireEvent.keyDown(items[1]!, { key: 'End' });
  expect(items[2]).toHaveFocus();
  fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
  expect(items[0]).toHaveFocus();
  fireEvent.keyDown(items[0]!, { key: 'p' });
  expect(items[1]).toHaveFocus();
  fireEvent.keyDown(items[1]!, { key: 'Escape' });
  expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pausieren' }));
  expect(onSelect).toHaveBeenCalledWith('pause');
  expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
});

it('menu: a click outside closes it', () => {
  render(<><Example onSelect={() => undefined} /><p>Außen</p></>);
  fireEvent.click(screen.getByRole('button', { name: /Weitere Aktionen/ }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  fireEvent.pointerDown(screen.getByText('Außen'));
  expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
});

function TabsExample() {
  const [selected, setSelected] = useState('media');
  return (
    <Tabs label="Bereiche" selected={selected} onSelect={setSelected} tabs={[{ id: 'media', label: 'Medien', count: 14 }, { id: 'schedules', label: 'Zeitpläne' }, { id: 'runs', label: 'Läufe' }]}>
      <p>{`Inhalt ${selected}`}</p>
    </Tabs>
  );
}

it('tabs: roving tabindex, arrows wrap, Home and End jump, the panel follows', () => {
  render(<TabsExample />);
  const [media, schedules, runs] = screen.getAllByRole('tab');
  expect(media).toHaveAttribute('aria-selected', 'true');
  expect(media).toHaveAttribute('tabindex', '0');
  expect(schedules).toHaveAttribute('tabindex', '-1');
  media!.focus();
  fireEvent.keyDown(media!, { key: 'ArrowRight' });
  expect(schedules).toHaveFocus();
  expect(schedules).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveTextContent('Inhalt schedules');
  fireEvent.keyDown(schedules!, { key: 'End' });
  expect(runs).toHaveFocus();
  fireEvent.keyDown(runs!, { key: 'ArrowRight' });
  expect(media).toHaveFocus();
  fireEvent.keyDown(media!, { key: 'ArrowLeft' });
  expect(runs).toHaveFocus();
  fireEvent.keyDown(runs!, { key: 'Home' });
  expect(media).toHaveFocus();
});

it('dialog: names itself by the title, puts the focus on the marked safe button, keeps Tab inside and returns the focus on close', () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Öffnen</button>
        {open && (
          <Dialog title="„Atelier Mori“ löschen?" close={() => setOpen(false)}>
            <button type="button">Löschen</button>
            <button type="button" data-autofocus onClick={() => setOpen(false)}>Abbrechen</button>
          </Dialog>
        )}
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByRole('button', { name: 'Öffnen' });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole('dialog', { name: '„Atelier Mori“ löschen?' });
  expect(within(dialog).getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
  const last = within(dialog).getAllByRole('button').at(-1)!;
  last.focus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it('switch: pending is announced as busy and does not fire a second change', () => {
  const onChange = vi.fn();
  render(<Switch label="Aktiv" checked onChange={onChange} pending />);
  const toggle = screen.getByRole('switch', { name: 'Aktiv' });
  expect(toggle).toBeChecked();
  expect(toggle).toHaveAttribute('aria-busy', 'true');
  fireEvent.click(toggle);
  expect(onChange).not.toHaveBeenCalled();
});

it('relative time: relative up to 24 hours, then short and absolute, with the full time as title', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  const { container } = render(
    <>
      <RelativeTime value="2026-10-11T11:18:00Z" />
      <RelativeTime value="2026-10-11T17:00:00Z" />
      <RelativeTime value="2026-10-12T00:30:00Z" />
      <RelativeTime value="2026-10-20T00:30:00Z" />
    </>
  );
  const texts = Array.from(container.querySelectorAll('time')).map((element) => element.textContent);
  expect(texts[0]).toBe('vor 42 Min.');
  expect(texts[1]).toBe('in 5 Std.');
  expect(texts[2]).toMatch(/^in \d+ Std\.$/);
  expect(texts[3]).toMatch(/^Di\., 20\.10\./);
  expect(container.querySelectorAll('time')[3]).toHaveAttribute('title');
  expect(container.querySelectorAll('time')[0]).toHaveAttribute('datetime', '2026-10-11T11:18:00.000Z');
});
