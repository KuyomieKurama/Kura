// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DisclosureSummary } from './DisclosureSummary.js';
import { DataTable, type Column } from './DataTable.js';

afterEach(cleanup);

type Row = { id: string; when: string; count: number };

const columns: Column<Row>[] = [
  { key: 'when', header: 'Beginn', render: (row) => row.when, date: true },
  { key: 'count', header: 'Anzahl', render: (row) => row.count, numeric: true }
];

it('gives header and value of a date column the same class, and keeps numbers apart', () => {
  render(<DataTable label="Test" columns={columns} rows={[{ id: '1', when: '09.10.2026, 20:51', count: 3 }]} rowKey={(row) => row.id} />);
  const header = screen.getByRole('columnheader', { name: 'Beginn' });
  const value = screen.getByRole('cell', { name: '09.10.2026, 20:51' });
  expect(header).toHaveClass('date');
  expect(value).toHaveClass('date');
  expect(header).not.toHaveClass('num');
  expect(screen.getByRole('columnheader', { name: 'Anzahl' })).toHaveClass('num');
  expect(screen.getByRole('cell', { name: '3' })).toHaveClass('num');
});

it('renders a disclosure summary with a caret icon instead of the browser marker', () => {
  const { container } = render(
    <details>
      <DisclosureSummary>Immich-Nachweis</DisclosureSummary>
      <p>Inhalt</p>
    </details>
  );
  const summary = container.querySelector('summary');
  expect(summary).toHaveClass('disclosure-summary');
  expect(summary).toHaveTextContent('Immich-Nachweis');
  expect(summary?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
});
