import type { ReactNode } from 'react';
import { useId } from 'react';

/**
 * One block of a settings page: a 280px column that says what the block is for, next to the form (at most 640px).
 * Below 1024px the explanation sits above the form. The block is a region named by its heading.
 */
export function SettingsSection({ title, explanation, children, headingId }: {
  title: string;
  explanation?: ReactNode;
  children: ReactNode;
  /** An id for the heading when a test or a link needs to name the block. */
  headingId?: string;
}) {
  const generated = useId();
  const id = headingId ?? `${generated}-heading`;
  return (
    <section className="settings-section" aria-labelledby={id}>
      <div className="settings-aside">
        <h2 id={id}>{title}</h2>
        {explanation && <p className="muted">{explanation}</p>}
      </div>
      <div className="settings-body">{children}</div>
    </section>
  );
}
