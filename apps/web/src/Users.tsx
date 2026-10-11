import { Lock, LockOpen, Plus, Prohibit } from '@phosphor-icons/react';
import { type FormEvent, useState } from 'react';
import { api, type User } from './api.js';
import { initials } from './AppShell.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { Dialog } from './ui/Dialog.js';
import { EmptyState } from './ui/EmptyState.js';
import { Field } from './ui/Field.js';
import { PageHeader } from './ui/PageHeader.js';
import { Chip } from './ui/Chip.js';

/** User administration (administrators only): list, create, lock and unlock. */
export function UsersPage({ users, currentUserId, reload }: {
  users: User[];
  currentUserId: string | undefined;
  reload: () => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmUser, setConfirmUser] = useState<User | null>(null);
  const [error, setError] = useState('');

  const activeAdmins = users.filter((item) => item.role === 'admin' && item.status === 'active');
  // The last active administrator cannot lock themselves out.
  const isLastActiveAdmin = (user: User) => (
    user.id === currentUserId && user.role === 'admin' && user.status === 'active' && activeAdmins.length === 1
  );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api.createUser({
        displayName: String(data.get('displayName')),
        username: String(data.get('username')),
        role: data.get('role') === 'admin' ? 'admin' : 'user',
        initialPassword: String(data.get('initialPassword'))
      });
      await reload();
      setCreateOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function changeStatus(user: User) {
    try {
      await api.updateUser(user.id, user.status === 'active' ? 'blocked' : 'active');
      await reload();
      setConfirmUser(null);
    } catch (cause) {
      setError(errorMessage(cause));
      setConfirmUser(null);
    }
  }

  const openCreate = () => {
    setError('');
    setCreateOpen(true);
  };

  return (
    <>
      <PageHeader
        title={labels.users}
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>{labels.createUser}</Button>}
      />
      {error && !createOpen && <Banner tone="danger">{error}</Banner>}
      {users.length === 0
        ? <EmptyState title={labels.noUsers} />
        : (
          // A list, not a table: avatar, name ("Du" on the own row), user name in mono, role as text. Only a lock is a chip.
          <ul className="user-list" aria-label={labels.users}>
            {users.map((user) => (
              <li key={user.id} className="user-row">
                <span className="avatar" aria-hidden="true">{initials(user.display_name)}</span>
                <span className="user-main">
                  <span className="user-name">
                    <span className="row-name" title={user.display_name}>{user.display_name}</span>
                    {user.id === currentUserId && <span className="meta">{labels.you}</span>}
                    {user.status === 'blocked' && <Chip tone="danger" icon={Prohibit}>{labels.blocked}</Chip>}
                  </span>
                  <span className="meta user-sub">
                    <span className="mono">{user.username}</span>
                    <span>{user.role === 'admin' ? labels.adminRole : labels.userRole}</span>
                    <span>{`${labels.userSince} ${new Date(user.created_at).toLocaleDateString('de-DE')}`}</span>
                  </span>
                </span>
                {!isLastActiveAdmin(user) && (
                  <Button variant="ghost" icon={user.status === 'active' ? Lock : LockOpen} aria-label={`${user.display_name} ${user.status === 'active' ? 'sperren' : 'entsperren'}`} onClick={() => setConfirmUser(user)}>
                    {user.status === 'active' ? labels.lock : labels.unlock}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

      {createOpen && (
        <Dialog title={labels.createUserTitle} close={() => setCreateOpen(false)}>
          <form onSubmit={create} className="form-stack">
            <Field label={labels.displayName}>
              {(control) => <input {...control} name="displayName" required autoComplete="name" />}
            </Field>
            <Field label={labels.username}>
              {(control) => <input {...control} name="username" required autoComplete="username" />}
            </Field>
            <Field label={labels.role}>
              {(control) => (
                <select {...control} name="role">
                  <option value="user">{labels.userRole}</option>
                  <option value="admin">{labels.adminRole}</option>
                </select>
              )}
            </Field>
            <Field label={labels.initialPassword} hint={labels.passwordHint}>
              {(control) => <input {...control} name="initialPassword" type="password" minLength={12} required autoComplete="new-password" />}
            </Field>
            {error && <Banner tone="danger">{error}</Banner>}
            <div className="form-actions">
              <Button variant="primary" type="submit">{labels.save}</Button>
              <Button onClick={() => setCreateOpen(false)}>{labels.cancel}</Button>
            </div>
          </form>
        </Dialog>
      )}

      {confirmUser && (
        <Dialog title={`${confirmUser.display_name} ${confirmUser.status === 'active' ? 'sperren' : 'entsperren'}`} close={() => setConfirmUser(null)}>
          <p>
            {confirmUser.status === 'active'
              ? `${confirmUser.display_name} (${confirmUser.username}) wird gesperrt und kann sich danach nicht mehr anmelden. Laufende Sitzungen enden. Heruntergeladene Dateien bleiben erhalten.`
              : `${confirmUser.display_name} (${confirmUser.username}) wird entsperrt und kann sich wieder anmelden.`}
          </p>
          <div className="form-actions">
            <Button
              variant={confirmUser.status === 'active' ? 'danger-solid' : 'primary'}
              onClick={() => void changeStatus(confirmUser)}
            >
              {confirmUser.status === 'active' ? labels.lock : labels.unlock}
            </Button>
            <Button data-autofocus onClick={() => setConfirmUser(null)}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
