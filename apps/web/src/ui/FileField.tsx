import { type ComponentProps, useState } from 'react';
import { File as FileGlyph } from '@phosphor-icons/react';
import { Field } from './Field.js';
import { Glyph } from './Glyph.js';

/**
 * A file field in the language of the interface: the button says "Datei wählen" and the line next to it says
 * "Keine Datei gewählt" or the name of the file. The native input stays in place (and keyboard focusable), invisible,
 * so that the browser's English text never shows.
 */
export function FileField({ label, hint, error, ...input }: { label: string; hint?: string; error?: string } & Omit<ComponentProps<'input'>, 'type' | 'id' | 'children'>) {
  const [name, setName] = useState('');
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <div className="file-field">
          <input
            {...control}
            {...input}
            type="file"
            className="file-input"
            onChange={(event) => {
              setName(event.target.files?.[0]?.name ?? '');
              input.onChange?.(event);
            }}
          />
          <span className="btn btn-secondary file-face" aria-hidden="true"><Glyph icon={FileGlyph} />Datei wählen</span>
          <span className={name ? 'file-name' : 'file-name muted'} title={name || undefined}>{name || 'Keine Datei gewählt'}</span>
        </div>
      )}
    </Field>
  );
}
