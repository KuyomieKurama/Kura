import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { Tone } from '../status.js';
import { Glyph } from './Glyph.js';

/** A pill with an icon and a text. Colour only supports the text, it never replaces it. */
export function Chip({ tone, icon, children, title }: { tone: Tone; icon: Icon; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      <Glyph icon={icon} size={14} />
      {children}
    </span>
  );
}
