import { ArrowsClockwise, ClockCounterClockwise, Gauge, Images, SquaresFour, UserCircle, Users } from '@phosphor-icons/react';
import { type FormEvent, useEffect, useState } from 'react';
import { PasswordForm } from './Account.js';
import { AdminLimitsPage } from './AdminLimits.js';
import { api, type AuthState, type User } from './api.js';
import { AppShell, type NavItem } from './AppShell.js';
import { ForcedPasswordScreen, LoadingScreen, LoginScreen, SetupScreen } from './AuthScreens.js';
import { Dashboard, type HealthState, type ServiceStatus } from './Dashboard.js';
import { errorMessage } from './error-message.js';
import { HistoryPage } from './History.js';
import { ImmichPage } from './Immich.js';
import { labels } from './labels.js';
import { SubscriptionsPage } from './Subscriptions.js';
import { PageHeader } from './ui/PageHeader.js';
import { UsersPage } from './Users.js';

type View =
  | 'loading' | 'setup' | 'login' | 'forced-password'
  | 'dashboard' | 'account' | 'users' | 'immich' | 'subscriptions' | 'history' | 'limits';

const STATUS_REFRESH_MS = 10_000;

export function App() {
  const [view, setView] = useState<View>('loading');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [health, setHealth] = useState<HealthState>('loading');
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [error, setError] = useState('');

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
        setView(state.passwordChangeRequired ? 'forced-password' : 'dashboard');
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
    { view: 'dashboard', label: labels.overview, icon: SquaresFour },
    { view: 'subscriptions', label: labels.subscriptions, icon: ArrowsClockwise },
    { view: 'history', label: labels.history, icon: ClockCounterClockwise },
    { view: 'immich', label: labels.immich, icon: Images },
    ...(isAdmin ? [{ view: 'users', label: labels.users, icon: Users }, { view: 'limits', label: labels.limits, icon: Gauge }] : []),
    { view: 'account', label: labels.account, icon: UserCircle }
  ];

  return (
    <AppShell
      items={navItems}
      active={view}
      onNavigate={(next) => setView(next as View)}
      userName={current?.display_name ?? current?.username ?? ''}
      userRole={auth?.role ? (isAdmin ? labels.adminRole : labels.userRole) : ''}
      onLogout={() => void logout()}
    >
      {view === 'dashboard' && <Dashboard health={health} status={status} checkedAt={checkedAt} onNavigate={(next) => setView(next as View)} />}
      {view === 'subscriptions' && <SubscriptionsPage isAdmin={isAdmin} />}
      {view === 'history' && <HistoryPage />}
      {view === 'limits' && isAdmin && <AdminLimitsPage />}
      {view === 'immich' && <ImmichPage isAdmin={isAdmin} />}
      {view === 'account' && (
        <>
          <PageHeader title={labels.account} />
          <section className="section narrow" aria-labelledby="password-heading">
            <h2 id="password-heading">{labels.changePasswordTitle}</h2>
            <PasswordForm done={() => setView('dashboard')} />
          </section>
        </>
      )}
      {view === 'users' && isAdmin && <UsersPage users={users} currentUserId={current?.id} reload={loadUsers} />}
    </AppShell>
  );
}
