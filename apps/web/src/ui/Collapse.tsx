import type { ReactNode } from 'react';

/**
 * Height transition for expandable rows. The content stays in the DOM, but is hidden from
 * keyboard and screen readers while closed (visibility in CSS). The button that controls it carries aria-expanded.
 */
export function Collapse({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  return (
    <div className="collapse" data-open={open} id={id}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
