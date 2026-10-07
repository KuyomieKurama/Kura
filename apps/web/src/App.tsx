import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, type AuthState, type ImmichTransfer, type User } from './api.js';
import { labels } from './labels.js';

type View = 'loading' | 'setup' | 'login' | 'forced-password' | 'dashboard' | 'account' | 'users' | 'immich';
type Status = { version: string; migrations: { appliedCount: number; latestVersion: string | null } };

function message(error: unknown) { return error instanceof Error ? error.message : labels.requestError; }
function Dialog({ title, children, close }: { title: string; children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [close]);
  return <div className="backdrop" role="presentation"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} ref={ref}><header><h2 id="dialog-title">{title}</h2><button type="button" onClick={close}>{labels.close}</button></header>{children}</div></div>;
}
function PasswordForm({ forced, done }: { forced?: boolean; done: () => void }) {
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); const currentPassword = String(data.get('currentPassword')); const newPassword = String(data.get('newPassword')); if (newPassword !== String(data.get('repeatPassword'))) { setError(labels.passwordMismatch); return; } try { await api.changePassword({ currentPassword, newPassword }); done(); } catch (cause) { setError(message(cause)); } }
  return <section><h2>{forced ? labels.changePasswordRequired : labels.changePasswordTitle}</h2>{forced && <p>{labels.changePasswordRequiredHint}</p>}<form onSubmit={submit}><label>{labels.currentPassword}<input name="currentPassword" type="password" autoComplete="current-password" required /></label><label>{labels.newPassword}<input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label><label>{labels.passwordRepeat}<input name="repeatPassword" type="password" autoComplete="new-password" minLength={12} required /></label><p>{labels.passwordHint}</p>{error && <p className="form-error" role="alert">{error}</p>}<button>{labels.changePasswordSubmit}</button></form></section>;
}
function ImmichPage() {
  const [connectionUrl, setConnectionUrl] = useState('');
  const [result, setResult] = useState('');
  const [transfer, setTransfer] = useState<ImmichTransfer | null>(null);

  useEffect(() => {
    void api.immichConnection().then(({ connection }) => setConnectionUrl(connection?.serverUrl ?? '')).catch((cause) => setResult(message(cause)));
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api.saveImmichConnection({ serverUrl: String(data.get('serverUrl')), apiKey: String(data.get('apiKey')) });
      setConnectionUrl(String(data.get('serverUrl')));
      setResult('Verbindung gespeichert. Der API-Schlüssel wird nicht angezeigt.');
      event.currentTarget.reset();
    } catch (cause) {
      setResult(message(cause));
    }
  }

  async function test() {
    try {
      const response = await api.testImmichConnection();
      setResult(`Serverversion: ${response.version}; unterstützt: ${response.supported ? 'ja' : 'nein'}.`);
    } catch (cause) {
      setResult(message(cause));
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('testFile');
    if (!(file instanceof File) || file.size === 0) {
      setResult('Bitte wählen Sie eine Testdatei aus.');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setResult('Die Testdatei darf höchstens 4 MiB groß sein.');
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    try {
      const response = await api.testImmichTransfer({ fileName: file.name, contentBase64: btoa(binary) });
      const status = await api.immichTransfer(response.transfer.id);
      setTransfer(status.transfer);
      if (status.transfer.status === 'verified') {
        setResult('Testübertragung verifiziert. Das lokale Original bleibt erhalten.');
      } else if (status.transfer.status === 'reconciling') {
        setResult('Testübertragung ist unklar und wird abgeglichen. Das lokale Original bleibt erhalten.');
      } else {
        setResult(`Testübertragung: ${status.transfer.status}. Das lokale Original bleibt erhalten.`);
      }
    } catch (cause) {
      setResult(message(cause));
    }
  }

  return <section>
    <h2>Immich</h2>
    <p>Lokale Originale werden bei diesem Test niemals gelöscht.</p>
    <form onSubmit={save}>
      <label>Server-URL<input name="serverUrl" type="url" value={connectionUrl} onChange={(event) => setConnectionUrl(event.target.value)} required /></label>
      <label>API-Schlüssel<input name="apiKey" type="password" required autoComplete="off" /></label>
      <button>Verbindung speichern</button>
    </form>
    <button type="button" className="secondary" onClick={() => void test()}>Verbindung testen</button>
    <form onSubmit={upload}>
      <h3>Testdatei übertragen</h3>
      <label>Testdatei<input name="testFile" type="file" required /></label>
      <button>Testdatei übertragen</button>
    </form>
    {transfer && <section aria-label="Status der letzten Testübertragung">
      <h3>Status der letzten Übertragung</h3>
      <p>Status: {transfer.status}</p>
      <p>Lokales Original: {transfer.localOriginalRetained ? 'bleibt erhalten' : 'unbekannt'}</p>
      <p>Originalnachweis: {transfer.evidence ? `Server ${transfer.evidence.serverVersion ?? 'unbekannt'}, ${transfer.evidence.byteLength ?? 'unbekannt'} Bytes, Album ${transfer.evidence.album ?? 'unbekannt'}.` : 'noch nicht vorhanden.'}</p>
    </section>}
    {result && <p role="status">{result}</p>}
  </section>;
}

export function App() {
  const [view, setView] = useState<View>('loading'); const [auth, setAuth] = useState<AuthState | null>(null); const [users, setUsers] = useState<User[]>([]); const [status, setStatus] = useState<Status | null>(null); const [healthOk, setHealthOk] = useState(false); const [error, setError] = useState(''); const [createOpen, setCreateOpen] = useState(false); const [confirmUser, setConfirmUser] = useState<User | null>(null);
  const loadUsers = async () => { const result = await api.users(); setUsers(result.users); };
  const initialize = async () => { try { const state = await api.state(); setAuth(state); if (new URLSearchParams(window.location.search).get('oidc') === 'error') setError(labels.ssoLoginFailed); if (!state.configured) setView('setup'); else if (!state.authenticated) setView('login'); else { await loadUsers(); setView(state.passwordChangeRequired ? 'forced-password' : 'dashboard'); } } catch (cause) { setError(message(cause)); setView('login'); } };
  useEffect(() => { api.setUnauthenticatedHandler(() => { setAuth(null); setUsers([]); setView('login'); }); void initialize(); }, []);
  useEffect(() => { if (view !== 'dashboard') return; let active = true; const refresh = async () => { try { const [healthResponse, statusResponse] = await api.status(); if (!healthResponse.ok || !statusResponse.ok) throw new Error(); const nextStatus = await statusResponse.json() as Status; if (active) { setHealthOk((await healthResponse.json() as { status: string }).status === 'ok'); setStatus(nextStatus); } } catch { if (active) setHealthOk(false); } }; void refresh(); const timer = window.setInterval(() => void refresh(), 10_000); return () => { active = false; window.clearInterval(timer); }; }, [view]);
  async function logout() { try { await api.logout(); } finally { setAuth(null); setUsers([]); setView('login'); } }
  const submitSetup = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const password = String(data.get('password')); if (password !== String(data.get('repeatPassword'))) { setError(labels.passwordMismatch); return; } try { await api.setup({ displayName: String(data.get('displayName')), username: String(data.get('username')), password, setupToken: String(data.get('setupToken') || '') }); await initialize(); } catch (cause) { setError(message(cause)); } };
  const submitLogin = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { const result = await api.login({ username: String(data.get('username')), password: String(data.get('password')) }); setAuth((current) => current ? { ...current, authenticated: true, passwordChangeRequired: result.passwordChangeRequired } : current); await loadUsers(); setView(result.passwordChangeRequired ? 'forced-password' : 'dashboard'); setError(''); } catch { setError(labels.loginFailed); } };
  const current = users[0];
  const banner = <p className="notice">{labels.testSurface}{window.location.protocol === 'http:' ? ` — ${labels.insecureConnection}` : ''}</p>;
  if (view === 'loading') return <main><p>{labels.loadingPage}</p></main>;
  if (view === 'setup') return <main className="auth"><h1>{labels.title}</h1>{banner}<section><h2>{labels.setupTitle}</h2><p>{labels.setupIntro}</p><form onSubmit={submitSetup}><label>{labels.displayName}<input name="displayName" autoComplete="name" required /></label><label>{labels.username}<input name="username" autoComplete="username" required /></label><label>{labels.password}<input name="password" type="password" autoComplete="new-password" minLength={12} required /></label><label>{labels.passwordRepeat}<input name="repeatPassword" type="password" autoComplete="new-password" minLength={12} required /></label><label>{labels.setupToken}<input name="setupToken" autoComplete="off" /></label><p>{labels.setupTokenHint}</p><p>{labels.passwordHint}</p>{error && <p className="form-error" role="alert">{error}</p>}<button>{labels.setupSubmit}</button></form></section></main>;
  if (view === 'login') return <main className="auth"><h1>{labels.title}</h1>{banner}<section><h2>{labels.loginTitle}</h2><form onSubmit={submitLogin}><label>{labels.username}<input name="username" autoComplete="username" required /></label><label>{labels.password}<input name="password" type="password" autoComplete="current-password" required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button>{labels.loginSubmit}</button></form>{auth?.oidcEnabled && <p><a className="button-link" href="/api/v1/auth/oidc/start">{labels.ssoLogin}</a></p>}</section></main>;
  if (view === 'forced-password') return <main className="auth"><h1>{labels.title}</h1>{banner}<PasswordForm forced done={() => setView('dashboard')} /><button type="button" className="secondary" onClick={() => void logout()}>{labels.logout}</button></main>;
  return <main><header className="app-header"><div><h1>{labels.title}</h1><span>{current?.display_name ?? current?.username ?? ''}{auth?.role ? ` · ${auth.role === 'admin' ? labels.adminRole : labels.userRole}` : ''}</span></div><nav><button type="button" onClick={() => setView('dashboard')}>{labels.title}</button><button type="button" onClick={() => setView('immich')}>Immich</button>{auth?.role === 'admin' && <button type="button" onClick={() => setView('users')}>{labels.users}</button>}<button type="button" onClick={() => setView('account')}>{labels.account}</button><button type="button" onClick={() => void logout()}>{labels.logout}</button></nav></header>{banner}{view === 'immich' && <ImmichPage />}{view === 'account' && <PasswordForm done={() => setView('dashboard')} />}{view === 'dashboard' && <><section className="cards"><article><h2>{labels.service}</h2><p className={healthOk ? 'ok' : 'error'}>{healthOk ? labels.available : labels.unavailable}</p><p>{labels.databaseAvailable}: {healthOk ? labels.available : labels.unavailable}</p></article><article><h2>{labels.database}</h2><p>{labels.migrations}: {status?.migrations.appliedCount ?? '–'}</p><p>{labels.latestMigration}: {status?.migrations.latestVersion ?? '–'}</p></article></section><section><h2>{labels.areas[0]}</h2><ul>{labels.areas.map((area) => <li key={area} aria-disabled="true">{area}</li>)}</ul></section></>}{view === 'users' && auth?.role === 'admin' && <section><div className="section-header"><h2>{labels.users}</h2><button type="button" onClick={() => setCreateOpen(true)}>{labels.createUser}</button></div>{users.length === 0 ? <p>{labels.noUsers}</p> : <div className="table-wrap"><table><thead><tr><th>{labels.userNameColumn}</th><th>{labels.userUsernameColumn}</th><th>{labels.userRoleColumn}</th><th>{labels.userStatusColumn}</th><th>{labels.userCreatedColumn}</th><th>{labels.userActionsColumn}</th></tr></thead><tbody>{users.map((user) => <tr key={user.id}><td>{user.display_name}</td><td>{user.username}</td><td>{user.role === 'admin' ? labels.adminRole : labels.userRole}</td><td>{user.status === 'active' ? labels.active : labels.blocked}</td><td>{new Date(user.created_at).toLocaleDateString('de-DE')}</td><td>{!(user.id === current?.id && user.role === 'admin' && user.status === 'active' && users.filter((item) => item.role === 'admin' && item.status === 'active').length === 1) && <button type="button" onClick={() => setConfirmUser(user)}>{user.status === 'active' ? labels.lock : labels.unlock}</button>}</td></tr>)}</tbody></table></div>}</section>}{createOpen && <Dialog title={labels.createUserTitle} close={() => setCreateOpen(false)}><form onSubmit={async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); try { await api.createUser({ displayName: String(data.get('displayName')), username: String(data.get('username')), role: data.get('role') === 'admin' ? 'admin' : 'user', initialPassword: String(data.get('initialPassword')) }); await loadUsers(); setCreateOpen(false); } catch (cause) { setError(message(cause)); } }}><label>{labels.displayName}<input name="displayName" required autoComplete="name" /></label><label>{labels.username}<input name="username" required autoComplete="username" /></label><label>{labels.role}<select name="role"><option value="user">{labels.userRole}</option><option value="admin">{labels.adminRole}</option></select></label><label>{labels.initialPassword}<input name="initialPassword" type="password" minLength={12} required autoComplete="new-password" /></label><p>{labels.passwordHint}</p>{error && <p className="form-error" role="alert">{error}</p>}<button>{labels.save}</button><button type="button" className="secondary" onClick={() => setCreateOpen(false)}>{labels.cancel}</button></form></Dialog>}{confirmUser && <Dialog title={confirmUser.status === 'active' ? labels.lock : labels.unlock} close={() => setConfirmUser(null)}><p>{confirmUser.status === 'active' ? labels.lockConfirm : labels.unlockConfirm}</p><button type="button" onClick={async () => { try { await api.updateUser(confirmUser.id, confirmUser.status === 'active' ? 'blocked' : 'active'); await loadUsers(); setConfirmUser(null); } catch (cause) { setError(message(cause)); setConfirmUser(null); } }}>{confirmUser.status === 'active' ? labels.lock : labels.unlock}</button><button type="button" className="secondary" onClick={() => setConfirmUser(null)}>{labels.cancel}</button></Dialog>}</main>;
}
