import { WarningCircle } from '@phosphor-icons/react';
import { type ReactNode, useId } from 'react';
import { Glyph } from './Glyph.js';

export type ControlProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true };

/**
 * A form field: label above, helper text below, error text below in danger.
 * The control comes from a render function so that id and aria-describedby always match.
 */
export function Field({ label, hint, error, wide, children }: {
  label: string;
  hint?: ReactNode;
  error?: string;
  wide?: boolean;
  children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ');
  const control: ControlProps = { id };
  if (describedBy) control['aria-describedby'] = describedBy;
  if (error) control['aria-invalid'] = true;
  return (
    <div className={wide ? 'field field-wide' : 'field'}>
      <label className="field-label" htmlFor={id}>{label}</label>
      {children(control)}
      {hint && <div className="field-hint" id={hintId}>{hint}</div>}
      {error && (
        <div className="field-error" id={errorId}>
          <Glyph icon={WarningCircle} size={16} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
