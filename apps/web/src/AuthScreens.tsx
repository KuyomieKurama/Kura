import { type FormEvent, type ReactNode } from 'react';
import { PasswordForm } from './Account.js';
import { TestStrip, Wordmark } from './AppShell.js';
import { labels } from './labels.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Field } from './ui/Field.js';

/** A single narrow panel, centred in the viewport, wordmark above. Used by loading, setup, login and forced password change. */
function AuthLayout({ title, intro, children }: { title?: string; intro?: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <TestStrip />
      <main className="auth-main" id="main">
        <div className="auth-column">
          <Wordmark />
          <div className="panel auth-panel">
            {title && <h1 className="auth-title">{title}</h1>}
            {intro && <p className="muted">{intro}</p>}
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <AuthLayout>
      <p role="status">{labels.loadingPage}</p>
    </AuthLayout>
  );
}

export function SetupScreen({ error, onSubmit }: { error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return (
    <AuthLayout title={labels.setupTitle} intro={labels.setupIntro}>
      <form onSubmit={onSubmit} className="form-stack">
        <Field label={labels.displayName}>
          {(control) => <input {...control} name="displayName" autoComplete="name" required />}
        </Field>
        <Field label={labels.username}>
          {(control) => <input {...control} name="username" autoComplete="username" required />}
        </Field>
        <Field label={labels.password} hint={labels.passwordHint}>
          {(control) => <input {...control} name="password" type="password" autoComplete="new-password" minLength={12} required />}
        </Field>
        <Field label={labels.passwordRepeat}>
          {(control) => <input {...control} name="repeatPassword" type="password" autoComplete="new-password" minLength={12} required />}
        </Field>
        <Field label={labels.setupToken} hint={labels.setupTokenHint}>
          {(control) => <input {...control} name="setupToken" autoComplete="off" />}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button variant="primary" type="submit" className="btn-block">{labels.setupSubmit}</Button>
      </form>
    </AuthLayout>
  );
}

export function LoginScreen({ error, oidcEnabled, onSubmit }: {
  error: string;
  oidcEnabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <AuthLayout title={labels.loginTitle}>
      <form onSubmit={onSubmit} className="form-stack">
        <Field label={labels.username}>
          {(control) => <input {...control} name="username" autoComplete="username" required />}
        </Field>
        <Field label={labels.password}>
          {(control) => <input {...control} name="password" type="password" autoComplete="current-password" required />}
        </Field>
        {error && <Banner tone="danger">{error}</Banner>}
        <Button variant="primary" type="submit" className="btn-block">{labels.loginSubmit}</Button>
      </form>
      {oidcEnabled && (
        <a className="btn btn-secondary btn-block" href="/api/v1/auth/oidc/start">{labels.ssoLogin}</a>
      )}
    </AuthLayout>
  );
}

export function ForcedPasswordScreen({ done, onLogout }: { done: () => void; onLogout: () => void }) {
  return (
    <AuthLayout title={labels.changePasswordRequired} intro={labels.changePasswordRequiredHint}>
      <PasswordForm done={done} />
      <Button variant="ghost" className="btn-block" onClick={onLogout}>{labels.logout}</Button>
    </AuthLayout>
  );
}
