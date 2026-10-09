import { Lock, LockOpen, Plus } from '@phosphor-icons/react';
import { type FormEvent, useState } from 'react';
import { api, type User } from './api.js';
import { errorMessage } from './error-message.js';
import { labels } from './labels.js';
import { Banner } from './ui/Banner.js';
import { Button } from './ui/Button.js';
import { DataTable, type Column } from './ui/DataTable.js';
import { Dialog } from './ui/Dialog.js';
import { EmptyState } from './ui/EmptyState.js';
import { Field } from './ui/Field.js';
import { PageHeader } from './ui/PageHeader.js';
import { StatusChip } from './ui/StatusChip.js';

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

  const columns: Column<User>[] = [
    { key: 'name', header: labels.userNameColumn, render: (user) => user.display_name },
    { key: 'username', header: labels.userUsernameColumn, render: (user) => user.username, mono: true },
    { key: 'role', header: labels.userRoleColumn, render: (user) => (user.role === 'admin' ? labels.adminRole : labels.userRole) },
    { key: 'status', header: labels.userStatusColumn, render: (user) => <StatusChip domain="user" status={user.status} /> },
    { key: 'created', header: labels.userCreatedColumn, render: (user) => new Date(user.created_at).toLocaleDateString('de-DE'), date: true },
    {
      key: 'actions',
      header: labels.userActionsColumn,
      actions: true,
      render: (user) => isLastActiveAdmin(user) ? null : (
        <Button variant="ghost" icon={user.status === 'active' ? Lock : LockOpen} onClick={() => setConfirmUser(user)}>
          {user.status === 'active' ? labels.lock : labels.unlock}
        </Button>
      )
    }
  ];

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
        : <DataTable label={labels.users} columns={columns} rows={users} rowKey={(user) => user.id} />}

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
        <Dialog title={confirmUser.status === 'active' ? labels.lock : labels.unlock} close={() => setConfirmUser(null)}>
          <p>{confirmUser.status === 'active' ? labels.lockConfirm : labels.unlockConfirm}</p>
          <div className="form-actions">
            <Button
              variant={confirmUser.status === 'active' ? 'danger-solid' : 'primary'}
              onClick={() => void changeStatus(confirmUser)}
            >
              {confirmUser.status === 'active' ? labels.lock : labels.unlock}
            </Button>
            <Button onClick={() => setConfirmUser(null)}>{labels.cancel}</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
