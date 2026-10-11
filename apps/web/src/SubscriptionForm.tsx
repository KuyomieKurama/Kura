import { FloppyDisk, MagnifyingGlass } from '@phosphor-icons/react';
import { type FormEvent, useRef, useState } from 'react';
import { api, type SourceValidation, type Subscription } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { SourceValidationView } from './SourceCheck.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Field } from './ui/Field.js';

export const PLATFORM_HINTS = [
  { value: '', label: 'Keine Angabe' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'patreon', label: 'Patreon' },
  { value: 'pixiv', label: 'Pixiv' },
  { value: 'pornhub', label: 'Pornhub' },
  { value: 'direct', label: 'Direkte Medien-URL' },
  { value: 'web', label: 'Allgemeine Webseite' }
];

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function SubscriptionForm({ subscription, onSaved, onCancel }: {
  subscription?: Subscription;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<SourceValidation | null>(null);
  const urlInput = useRef<HTMLInputElement>(null);

  async function check() {
    try {
      setValidation(await api.validateSource(urlInput.current?.value ?? ''));
      setError('');
    } catch (cause) {
      setValidation(null);
      setError(errorMessage(cause));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input = {
      name: String(data.get('name') ?? ''),
      targetUrl: String(data.get('targetUrl') ?? ''),
      platformHint: String(data.get('platformHint') ?? '') || null
    };
    try {
      const saved = subscription ? await api.updateSubscription(subscription.id, input) : await api.createSubscription(input);
      // Records whether an adapter accepts the address; saving does not depend on it.
      await api.validateSubscription(saved.subscription.id).catch(() => undefined);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label={subscription ? 'Abonnement bearbeiten' : 'Abonnement anlegen'}
      className="form-grid"
    >
      <Field label="Name">
        {(control) => <input {...control} name="name" defaultValue={subscription?.name ?? ''} maxLength={200} required />}
      </Field>
      <Field label="Plattform (Hinweis)">
        {(control) => (
          <select {...control} name="platformHint" defaultValue={subscription?.platformHint ?? ''}>
            {PLATFORM_HINTS.map((hint) => <option key={hint.value} value={hint.value}>{hint.label}</option>)}
          </select>
        )}
      </Field>
      <Field
        label="Ziel-URL"
        wide
        hint="Die Adresse wird unverändert gespeichert. Mit „Adresse prüfen“ siehst du, welche Plattform erkannt wird und was der Adapter kann. Dabei wird nichts heruntergeladen."
      >
        {(control) => (
          <input {...control} name="targetUrl" ref={urlInput} defaultValue={subscription?.targetUrl ?? ''} maxLength={2048} required autoComplete="off" />
        )}
      </Field>
      <div className="form-wide">
        <Button icon={MagnifyingGlass} onClick={() => void check()}>Adresse prüfen</Button>
      </div>
      {validation && <div className="form-wide"><SourceValidationView result={validation} /></div>}
      {error && <div className="form-wide"><Banner tone="danger">{error}</Banner></div>}
      <div className="form-actions form-wide">
        <Button variant="primary" type="submit" icon={FloppyDisk}>{labels.save}</Button>
        <Button variant="ghost" onClick={onCancel}>{labels.cancel}</Button>
      </div>
    </form>
  );
}
