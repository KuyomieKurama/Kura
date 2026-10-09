import type { Icon } from '@phosphor-icons/react';

/** One icon family (Phosphor, regular weight). Icons are decoration: the text next to them carries the meaning. */
export function Glyph({ icon: Component, size = 16 }: { icon: Icon; size?: number }) {
  return <Component size={size} weight="regular" aria-hidden="true" focusable="false" />;
}
