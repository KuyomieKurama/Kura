import { type FormEvent, useState } from 'react';
import { api } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Field } from './ui/Field.js';

/** Change of the own password. Used on the account page and, when the server demands it, right after login. */
export function PasswordForm({ done }: { done: () => void }) {
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const currentPassword = String(data.get('currentPassword'));
    const newPassword = String(data.get('newPassword'));
    if (newPassword !== String(data.get('repeatPassword'))) {
      setError(labels.passwordMismatch);
      return;
    }
    try {
      await api.changePassword({ currentPassword, newPassword });
      done();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <form onSubmit={submit} className="form-stack">
      <Field label={labels.currentPassword}>
        {(control) => <input {...control} name="currentPassword" type="password" autoComplete="current-password" required />}
      </Field>
      <Field label={labels.newPassword} hint={labels.passwordHint}>
        {(control) => <input {...control} name="newPassword" type="password" autoComplete="new-password" minLength={12} required />}
      </Field>
      <Field label={labels.passwordRepeat}>
        {(control) => <input {...control} name="repeatPassword" type="password" autoComplete="new-password" minLength={12} required />}
      </Field>
      {error && <Banner tone="danger">{error}</Banner>}
      <div className="form-actions">
        <Button variant="primary" type="submit">{labels.changePasswordSubmit}</Button>
      </div>
    </form>
  );
}
