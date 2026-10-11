import { ArrowsClockwise, ClockCounterClockwise, Gauge, Image, Images, SquaresFour, Users } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useState } from 'react';
import { PasswordForm } from './Account.js';
import { AdminLimitsPage } from './AdminLimits.js';
import { api, type AuthState, type User, type VersionInfo } from './api.js';
import { AppShell, type NavItem } from './AppShell.js';
import { ForcedPasswordScreen, LoadingScreen, LoginScreen, SetupScreen } from './AuthScreens.js';
import { Dashboard, type HealthState, type ServiceStatus } from './Dashboard.js';
import { errorMessage } from './error-message.js';
import { HistoryPage } from './History.js';
import { MediaPage } from './MediaPage.js';
import { ImmichPage } from './Immich.js';
import { CredentialsSection } from './Credentials.js';
import { labels } from './labels.js';
import { SubscriptionsPage } from './Subscriptions.js';
import { Button } from './ui/Button.js';
import { PageHeader } from './ui/PageHeader.js';
import { ToastProvider } from './ui/Toast.js';
import { UsersPage } from './Users.js';
import { hasNewVersion, VersionNotice, VersionPage, versionLabel, versionTexts } from './Version.js';

type View =
  | 'loading' | 'setup' | 'login' | 'forced-password'
  | 'dashboard' | 'media' | 'account' | 'users' | 'immich' | 'subscriptions' | 'history' | 'limits' | 'version';

const STATUS_REFRESH_MS = 10_000;
// The server checks GitHub every 12 hours; this only re-reads its cached answer.
const VERSION_REFRESH_MS = 30 * 60_000;
const SIGNED_OUT_VIEWS: readonly View[] = ['loading', 'setup', 'login', 'forced-password'];

export function App() {
  const [view, setView] = useState<View>('loading');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [health, setHealth] = useState<HealthState>('loading');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const signedIn = !SIGNED_OUT_VIEWS.includes(view);

  const loadUsers = async () => {
    const result = await api.users();
    setUsers(result.users);
  };

  const initialize = async () => {
    try {
      const state = await api.state();
      setAuth(state);
      if (new URLSearchParams(window.location.search).get('oidc') === 'error') setError(labels.ssoLoginFailed);
      if (!state.configured) {
        setView('setup');
      } else if (!state.authenticated) {
        setView('login');
      } else {
        await loadUsers();
        setView(state.passwordChangeRequired ? 'forced-password' : window.location.hash.startsWith('#/abonnements') ? 'subscriptions' : 'dashboard');
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setView('login');
    }
  };

  useEffect(() => {
    api.setUnauthenticatedHandler(() => {
      setAuth(null);
      setUsers([]);
      setView('login');
    });
    void initialize();
  }, []);

  useEffect(() => {
    if (view !== 'dashboard') return;
    let active = true;
    const refresh = async () => {
      try {
        const [healthResponse, statusResponse] = await api.status();
        if (!healthResponse.ok || !statusResponse.ok) throw new Error();
        const nextStatus = await statusResponse.json() as ServiceStatus;
        const healthBody = await healthResponse.json() as { status: string };
        if (active) {
          setHealth(healthBody.status === 'ok' ? 'ok' : 'error');
          setStatus(nextStatus);
          setCheckedAt(new Date());
        }
      } catch {
        if (active) setHealth('error');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), STATUS_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [view]);

  // The version line and the notice need the answer of GET /version. A failure only hides them.
  useEffect(() => {
    if (!signedIn) {
      setVersionInfo(null);
      return;
    }
    let active = true;
    const refresh = () => {
      api.version().then((next) => { if (active) setVersionInfo(next); }, () => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, VERSION_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [signedIn]);

  async function dismissVersionNotice() {
    if (!versionInfo?.latestVersion) return;
    try {
      await api.dismissVersionNotice(versionInfo.latestVersion);
      setVersionInfo({ ...versionInfo, noticeDismissed: true });
    } catch {
      // The strip stays; the next try may work.
    }
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setAuth(null);
      setUsers([]);
      setView('login');
    }
  }

  const submitSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password'));
    if (password !== String(data.get('repeatPassword'))) {
      setError(labels.passwordMismatch);
      return;
    }
    try {
      await api.setup({
        displayName: String(data.get('displayName')),
        username: String(data.get('username')),
        password,
        setupToken: String(data.get('setupToken') || '')
      });
      await initialize();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = await api.login({ username: String(data.get('username')), password: String(data.get('password')) });
      setAuth((current) => current ? { ...current, authenticated: true, passwordChangeRequired: result.passwordChangeRequired } : current);
      await loadUsers();
      setView(result.passwordChangeRequired ? 'forced-password' : 'dashboard');
      setError('');
    } catch {
      setError(labels.loginFailed);
    }
  };

  if (view === 'loading') return <LoadingScreen />;
  if (view === 'setup') return <SetupScreen error={error} onSubmit={submitSetup} />;
  if (view === 'login') return <LoginScreen error={error} oidcEnabled={Boolean(auth?.oidcEnabled)} onSubmit={submitLogin} />;
  if (view === 'forced-password') return <ForcedPasswordScreen done={() => setView('dashboard')} onLogout={() => void logout()} />;

  const isAdmin = auth?.role === 'admin';
  const current = users[0];
  const navItems: NavItem[] = [
    { view: 'dashboard', label: labels.overview, icon: SquaresFour, group: 'main' },
    { view: 'media', label: labels.media, icon: Image, group: 'main' },
    { view: 'subscriptions', label: labels.subscriptions, shortLabel: labels.subscriptionsShort, icon: ArrowsClockwise, group: 'main' },
    { view: 'history', label: labels.history, icon: ClockCounterClockwise, group: 'main' },
    { view: 'immich', label: labels.immich, icon: Images, group: 'main', more: true },
    ...(isAdmin
      ? [
        { view: 'users', label: labels.users, icon: Users, group: 'admin' as const, more: true },
        { view: 'limits', label: labels.limits, icon: Gauge, group: 'admin' as const, more: true }
      ]
      : [])
  ];

  return (
    <ToastProvider>
    <AppShell
      items={navItems}
      active={view}
      onNavigate={(next) => setView(next as View)}
      userName={current?.display_name ?? current?.username ?? ''}
      userRole={auth?.role ? (isAdmin ? labels.adminRole : labels.userRole) : ''}
      onLogout={() => void logout()}
      pageTitle={view === 'version' ? versionTexts.title : undefined}
      version={versionInfo ? {
        label: versionLabel(versionInfo),
        newVersion: hasNewVersion(versionInfo) ? versionInfo.latestVersion : null,
        current: view === 'version',
        onOpen: () => setView('version')
      } : undefined}
      notice={isAdmin && versionInfo && hasNewVersion(versionInfo) && !versionInfo.noticeDismissed && view !== 'version'
        ? <VersionNotice info={versionInfo} onDetails={() => setView('version')} onDismiss={() => void dismissVersionNotice()} />
        : undefined}
    >
      {view === 'dashboard' && <Dashboard health={health} status={status} checkedAt={checkedAt} onNavigate={(next) => setView(next as View)} />}
      {view === 'media' && <MediaPage />}
      {view === 'subscriptions' && <SubscriptionsPage isAdmin={isAdmin} onOpenHistory={() => setView('history')} />}
      {view === 'history' && <HistoryPage onOpenSubscriptions={() => setView('subscriptions')} />}
      {view === 'limits' && isAdmin && <AdminLimitsPage />}
      {view === 'immich' && <ImmichPage isAdmin={isAdmin} />}
      {view === 'account' && (
        <>
          <PageHeader title={labels.account} />
          <section className="section narrow" aria-labelledby="password-heading">
            <h2 id="password-heading">{labels.changePasswordTitle}</h2>
            <PasswordForm done={() => setView('dashboard')} />
          </section>
          <CredentialsSection />
          <section className="section narrow" aria-labelledby="about-heading">
            <h2 id="about-heading">{versionTexts.title}</h2>
            <p className="muted">{versionInfo ? `${versionLabel(versionInfo)}, Status: ${versionTexts.statusLabels[versionInfo.status]}` : 'Kura'}</p>
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setView('version')}>{versionTexts.linkTitle}</Button>
            </div>
          </section>
        </>
      )}
      {view === 'version' && <VersionPage info={versionInfo} isAdmin={isAdmin} onChanged={setVersionInfo} />}
      {view === 'users' && isAdmin && <UsersPage users={users} currentUserId={current?.id} reload={loadUsers} />}
    </AppShell>
    </ToastProvider>
  );
}
