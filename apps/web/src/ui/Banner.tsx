import { CheckCircle, Info, Warning, WarningCircle } from '@phosphor-icons/react';
import { forwardRef, type ReactNode } from 'react';
import { Glyph } from './Glyph.js';

export type BannerTone = 'danger' | 'warn' | 'ok' | 'info';

const icons = { danger: WarningCircle, warn: Warning, ok: CheckCircle, info: Info } as const;

/**
 * An inline message above or inside the content it belongs to: a soft area in the tone, a 2px bar on the left, an icon,
 * a bold sentence and a help sentence, optionally an action. Errors that need action use this, not a toast.
 * `role` defaults to "alert" for danger and warn, and to "status" otherwise. It can take focus (tabIndex -1) so that an
 * error in a form can be announced and read.
 */
export const Banner = forwardRef<HTMLDivElement, { tone: BannerTone; children: ReactNode; role?: 'alert' | 'status'; action?: ReactNode }>(
  function Banner({ tone, children, role, action }, ref) {
    const effectiveRole = role ?? (tone === 'danger' || tone === 'warn' ? 'alert' : 'status');
    return (
      <div className={`banner banner-${tone}`} role={effectiveRole} tabIndex={-1} ref={ref}>
        <Glyph icon={icons[tone]} size={18} />
        <div className="banner-body">{children}</div>
        {action && <div className="banner-action">{action}</div>}
      </div>
    );
  }
);
