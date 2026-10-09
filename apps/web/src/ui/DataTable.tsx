import type { ReactNode } from 'react';

export type Column<Row> = {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
  /** Dates and times: left-aligned like text, tabular figures so rows line up. */
  date?: boolean;
  /** Ids, hashes and counts in the mono face. */
  mono?: boolean;
  /** Row actions: right-aligned, no label in the stacked layout. */
  actions?: boolean;
};

function cellClass<Row>(column: Column<Row>): string | undefined {
  const classes = [column.numeric && 'num', column.date && 'date', column.mono && 'cell-mono', column.actions && 'actions'].filter(Boolean);
  return classes.length > 0 ? classes.join(' ') : undefined;
}

/**
 * Dense table: sticky header, 40px rows, hover background, numbers right-aligned.
 * Below 640px the rows stack as label/value pairs, driven by the data-label attribute.
 */
export function DataTable<Row>({ label, columns, rows, rowKey }: {
  label: string;
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
}) {
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={cellClass(column)}>{column.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={cellClass(column)} data-label={column.actions ? undefined : column.header}>
                  <div className="cell">{column.render(row)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
