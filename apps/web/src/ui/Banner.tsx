import { CheckCircle, Info, Warning, WarningCircle } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Glyph } from './Glyph.js';

export type BannerTone = 'danger' | 'warn' | 'ok' | 'info';

const icons = { danger: WarningCircle, warn: Warning, ok: CheckCircle, info: Info } as const;

/**
 * An inline message above or inside the content it belongs to. Errors that need action use this, not a toast.
 * `role` defaults to "alert" for danger and warn, and to "status" otherwise.
 */
export function Banner({ tone, children, role }: { tone: BannerTone; children: ReactNode; role?: 'alert' | 'status' }) {
  const effectiveRole = role ?? (tone === 'danger' || tone === 'warn' ? 'alert' : 'status');
  return (
    <div className={`banner banner-${tone}`} role={effectiveRole}>
      <Glyph icon={icons[tone]} size={18} />
      <div className="banner-body">{children}</div>
    </div>
  );
}
