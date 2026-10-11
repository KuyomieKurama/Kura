import type { Icon } from '@phosphor-icons/react';
import { DotsThree, SignOut, UserCircle, Warning } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useState } from 'react';
import { labels } from './labels.js';
import { useMediaQuery } from './useMediaQuery.js';
import { Dialog } from './ui/Dialog.js';
import { Glyph } from './ui/Glyph.js';
import { Menu } from './ui/Menu.js';
import { versionTexts } from './Version.js';

export type NavItem = {
  view: string;
  label: string;
  icon: Icon;
  /** "main" entries sit at the top, "admin" entries under the group "Verwaltung". */
  group: 'main' | 'admin';
  /** The short label of the bottom navigation. */
  shortLabel?: string;
  /** On narrow screens the entry sits in the "Mehr" sheet instead of the bottom bar. */
  more?: boolean;
};

/** The mark: a gabled storehouse with two shelves, one shape. Colours come from the tokens, not from the file. */
export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={size === 'lg' ? 'wordmark wordmark-lg' : 'wordmark'}>
      <svg className="wordmark-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path className="mark-body" d="M16 2.5 29.5 10.5V29.5H2.5V10.5Z" />
        <path className="mark-shelf" d="M9 16h14v3H9zM9 22h9v3H9z" />
      </svg>
      <span>{labels.title}</span>
    </span>
  );
}

/** The slim, persistent strip that says this is a test surface, one line across the full width. Not an alert. */
export function TestStrip() {
  const insecure = window.location.protocol === 'http:';
  return (
    <p className="test-strip">
      <Glyph icon={Warning} size={16} />
      <span>{insecure ? `${labels.testSurface}: ${labels.insecureConnection}` : labels.testSurface}</span>
    </p>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}` : (parts[0] ?? '').slice(0, 2);
  return letters.toUpperCase() || '?';
}

type VersionLine = { label: string; newVersion: string | null; current: boolean; onOpen: () => void };

function VersionButton({ version, onOpen }: { version: VersionLine; onOpen: () => void }) {
  return (
    <button type="button" className="version-link" title="Version und Update" aria-current={version.current ? 'page' : undefined} onClick={onOpen}>
      <span>{version.label}</span>
      {version.newVersion && <span className="version-new">{`${versionTexts.newVersion} ${version.newVersion}`}</span>}
    </button>
  );
}

/**
 * From 1024px: the test strip across the full width, a 248px sidebar with the navigation, the group "Verwaltung",
 * the user popover and the version line. Below that: a top bar and a bottom navigation with a "Mehr" sheet.
 * There is exactly one navigation in the DOM (conditional rendering by matchMedia).
 */
export function AppShell({ items, active, onNavigate, userName, userRole, onLogout, pageTitle, version, notice, children }: {
  items: NavItem[];
  active: string;
  onNavigate: (view: string) => void;
  userName: string;
  userRole: string;
  onLogout: () => void;
  /** Title of a page that is not in the navigation (account, version). */
  pageTitle?: string;
  /** Version line with the marker for a newer version, and where it leads. */
  version?: VersionLine;
  /** A strip above the page content, for example the notice about a new version. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    const current = items.find((item) => item.view === active);
    const title = current?.label ?? pageTitle;
    document.title = title ? `${title} | ${labels.title}` : labels.title;
  }, [active, items, pageTitle]);

  function navigate(view: string) {
    setMoreOpen(false);
    onNavigate(view);
    document.getElementById('main')?.focus();
  }

  const mainItems = items.filter((item) => item.group === 'main');
  const adminItems = items.filter((item) => item.group === 'admin');
  const barItems = items.filter((item) => !item.more);
  const moreItems = items.filter((item) => item.more);
  const moreActive = active === 'account' || active === 'version' || moreItems.some((item) => item.view === active);

  const navButton = (item: NavItem) => (
    <li key={item.view}>
      <button type="button" className="nav-item" aria-current={item.view === active ? 'page' : undefined} onClick={() => navigate(item.view)}>
        <Glyph icon={item.icon} size={18} />
        {item.label}
      </button>
    </li>
  );

  return (
    <div className={desktop ? 'shell' : 'shell shell-compact'}>
      <a className="skip-link" href="#main">{labels.skipToContent}</a>
      <TestStrip />
      {desktop
        ? (
          <aside className="sidebar">
            <header className="sidebar-top"><Wordmark /></header>
            <div className="sidebar-body">
              <nav aria-label={labels.mainNavigation}>
                <ul className="nav-list">{mainItems.map(navButton)}</ul>
                {adminItems.length > 0 && (
                  <>
                    <p className="nav-group">{labels.administration}</p>
                    <ul className="nav-list">{adminItems.map(navButton)}</ul>
                  </>
                )}
              </nav>
              <div className="sidebar-foot">
                <Menu
                  label={`${labels.account}: ${userName}`}
                  placement="top-start"
                  triggerClassName="user-button"
                  trigger={(
                    <>
                      <span className="avatar" aria-hidden="true">{initials(userName)}</span>
                      <span className="user-text">
                        <span className="account-name">{userName}</span>
                        {userRole && <span className="meta">{userRole}</span>}
                      </span>
                    </>
                  )}
                  items={[
                    { label: labels.account, icon: UserCircle, onSelect: () => navigate('account') },
                    { label: labels.logout, icon: SignOut, onSelect: onLogout, separatorBefore: true }
                  ]}
                />
                {version && <VersionButton version={version} onOpen={() => { setMoreOpen(false); version.onOpen(); document.getElementById('main')?.focus(); }} />}
              </div>
            </div>
          </aside>
        )
        : (
          <>
            <header className="topbar"><Wordmark /></header>
            <nav className="bottomnav" aria-label={labels.mainNavigation}>
              <ul>
                {barItems.map((item) => (
                  <li key={item.view}>
                    <button type="button" className="bottomnav-item" aria-current={item.view === active ? 'page' : undefined} onClick={() => navigate(item.view)}>
                      <Glyph icon={item.icon} size={22} />
                      <span>{item.shortLabel ?? item.label}</span>
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" className="bottomnav-item" aria-current={moreActive ? 'page' : undefined} aria-haspopup="dialog" onClick={() => setMoreOpen(true)}>
                    <Glyph icon={DotsThree} size={22} />
                    <span>{labels.more}</span>
                  </button>
                </li>
              </ul>
            </nav>
          </>
        )}
      <main id="main" tabIndex={-1} className="main">
        {notice}
        <div className="page">{children}</div>
      </main>
      {!desktop && moreOpen && (
        <Dialog title={labels.more} close={() => setMoreOpen(false)}>
          <ul className="sheet-list">
            {moreItems.map((item) => (
              <li key={item.view}>
                <button type="button" className="sheet-item" onClick={() => navigate(item.view)}>
                  <Glyph icon={item.icon} size={20} />
                  {item.label}
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="sheet-item" onClick={() => navigate('account')}>
                <Glyph icon={UserCircle} size={20} />
                {labels.account}
              </button>
            </li>
            {version && (
              <li>
                <button type="button" className="sheet-item sheet-version" onClick={() => { setMoreOpen(false); version.onOpen(); document.getElementById('main')?.focus(); }}>
                  <span>{version.label}</span>
                  {version.newVersion && <span className="version-new">{`${versionTexts.newVersion} ${version.newVersion}`}</span>}
                </button>
              </li>
            )}
            <li>
              <button type="button" className="sheet-item" onClick={() => { setMoreOpen(false); onLogout(); }}>
                <Glyph icon={SignOut} size={20} />
                {labels.logout}
              </button>
            </li>
          </ul>
        </Dialog>
      )}
    </div>
  );
}
