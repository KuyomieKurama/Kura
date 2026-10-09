import { CaretDown } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Glyph } from './Glyph.js';

/**
 * Summary line of a native <details>: the same caret as the other disclosures instead of the browser's
 * triangle. The caret turns when the details element is open (see .summary-caret in the stylesheet).
 */
export function DisclosureSummary({ children }: { children: ReactNode }) {
  return (
    <summary className="disclosure-summary">
      <span>{children}</span>
      <span className="summary-caret">
        <Glyph icon={CaretDown} />
      </span>
    </summary>
  );
}
