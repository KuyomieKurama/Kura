import { type FormEvent, type ReactNode, useEffect, useRef } from 'react';
import { PasswordForm } from './Account.js';
import { TestStrip, Wordmark } from './AppShell.js';
import { labels } from './labels.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Field } from './ui/Field.js';

const INTRO_KEY = 'kura-intro-played';

/** The staggered appearance of the contact sheet plays once per browser session. */
function useIntroOnce(): boolean {
  const first = useRef<boolean | null>(null);
  if (first.current === null) {
    try {
      first.current = window.sessionStorage.getItem(INTRO_KEY) === null;
    } catch {
      first.current = false;
    }
  }
  useEffect(() => {
    try {
      window.sessionStorage.setItem(INTRO_KEY, '1');
    } catch {
      // Private mode: the intro may play again on the next load.
    }
  }, []);
  return first.current;
}

/** Twelve empty frames in the shapes of photos: a contact sheet. Static, aria-hidden, no image from the server. */
const FRAMES = ['s', 'p', 'l', 'w', 'l', 'p', 's', 'w', 'p', 'l', 's', 'l'] as const;
const ACCENT_FRAME = 5;

function ContactSheet({ intro }: { intro: boolean }) {
  return (
    <div className="contact-sheet" aria-hidden="true" data-intro={intro}>
      <div className="contact-frames">
        {FRAMES.map((shape, index) => (
          <span key={index} className={`frame frame-${shape}${index === ACCENT_FRAME ? ' frame-accent' : ''}`} />
        ))}
      </div>
    </div>
  );
}

/** Left half: the form on the page colour, no card. Right half: the contact sheet (a 96px strip on small screens). */
function AuthLayout({ children, intro }: { children: ReactNode; intro?: boolean }) {
  const play = useIntroOnce();
  return (
    <div className="auth-page">
      <TestStrip />
      <div className="auth-split">
        <ContactSheet intro={intro ?? play} />
        <main className="auth-main" id="main" tabIndex={-1}>
          <div className="auth-column">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** "Das hat nicht geklappt. Prüfe …": the first sentence in bold, the help sentence after it. */
function ErrorText({ text }: { text: string }) {
  const end = text.search(/[.!?](\s|$)/);
  if (end < 0 || end === text.length - 1) return <strong>{text}</strong>;
  return <><strong>{text.slice(0, end + 1)}</strong> {text.slice(end + 2)}</>;
}

/** The error banner sits directly above the form and takes the focus when it appears. */
function useErrorFocus(error: string) {
  const banner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) banner.current?.focus();
  }, [error]);
  return banner;
}

export function LoadingScreen() {
  return (
    <AuthLayout intro={false}>
      <Wordmark size="lg" />
      <p role="status" className="auth-lede">{labels.loadingPage}</p>
    </AuthLayout>
  );
}

export function SetupScreen({ error, onSubmit }: { error: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const banner = useErrorFocus(error);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!error) return;
    // The fields keep their values, the passwords do not.
    form.current?.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => { input.value = ''; });
  }, [error]);
  return (
    <AuthLayout>
      <Wordmark />
      <div className="auth-intro">
        <h1 className="auth-title">{labels.setupTitle}</h1>
        <p className="auth-lede">{labels.setupIntro}</p>
      </div>
      {error && <Banner tone="danger" ref={banner}><ErrorText text={error} /></Banner>}
      <form onSubmit={onSubmit} className="form-stack" ref={form}>
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
  const banner = useErrorFocus(error);
  const password = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (error && password.current) password.current.value = '';
  }, [error]);
  return (
    <AuthLayout>
      <h1 className="sr-only">{labels.loginTitle}</h1>
      <div className="auth-hero"><Wordmark size="lg" /></div>
      <p className="auth-lede">{labels.loginLede}</p>
      {error && <Banner tone="danger" ref={banner}><ErrorText text={error} /></Banner>}
      <form onSubmit={onSubmit} className="form-stack">
        <Field label={labels.username}>
          {(control) => <input {...control} name="username" autoComplete="username" required />}
        </Field>
        <Field label={labels.password}>
          {(control) => <input {...control} name="password" type="password" autoComplete="current-password" ref={password} required />}
        </Field>
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
    <AuthLayout>
      <Wordmark />
      <div className="auth-intro">
        <h1 className="auth-title">{labels.changePasswordRequired}</h1>
        <p className="auth-lede">{labels.changePasswordRequiredHint}</p>
      </div>
      <PasswordForm done={done} />
      <Button variant="ghost" className="btn-block" onClick={onLogout}>{labels.logout}</Button>
    </AuthLayout>
  );
}
