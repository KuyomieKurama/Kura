import type { ReactNode } from 'react';

/** Page title row: title on the left, the one primary action on the right, an optional lead below. */
export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-title-row">
        <h1>{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {lead && <p className="page-lead">{lead}</p>}
    </header>
  );
}
