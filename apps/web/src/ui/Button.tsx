import type { Icon } from '@phosphor-icons/react';
import type { ComponentProps } from 'react';
import { Glyph } from './Glyph.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'danger-solid';

type ButtonProps = ComponentProps<'button'> & {
  variant?: ButtonVariant;
  icon?: Icon;
};

/** Every button has a visible text; the icon is optional decoration. Defaults to type="button". */
export function Button({ variant = 'secondary', icon, type = 'button', className, children, ...rest }: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {icon && <Glyph icon={icon} />}
      {children}
    </button>
  );
}
