import type { Icon } from '@phosphor-icons/react';
import { List, SignOut, Warning, X } from '@phosphor-icons/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { labels } from './labels.js';
import { Button } from './ui/Button.js';
import { Glyph } from './ui/Glyph.js';

export type NavItem = { view: string; label: string; icon: Icon };

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{labels.title}</span>
    </span>
  );
}

/** The slim, persistent strip that says this is a test surface. Not an alert: it does not interrupt. */
export function TestStrip() {
  const insecure = window.location.protocol === 'http:';
  return (
    <p className="test-strip">
      <Glyph icon={Warning} size={16} />
      <span>{insecure ? `${labels.testSurface}: ${labels.insecureConnection}` : labels.testSurface}</span>
    </p>
  );
}

/**
 * Desktop: fixed sidebar. Below 1024px the same markup is a top bar whose navigation is a disclosure
 * (button with aria-expanded, Escape closes). There is exactly one navigation in the DOM.
 */
export function AppShell({ items, active, onNavigate, userName, userRole, onLogout, children }: {
  items: NavItem[];
  active: string;
  onNavigate: (view: string) => void;
  userName: string;
  userRole: string;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  useEffect(() => {
    const current = items.find((item) => item.view === active);
    document.title = current ? `${current.label} | ${labels.title}` : labels.title;
  }, [active, items]);

  function navigate(view: string) {
    setMenuOpen(false);
    onNavigate(view);
    document.getElementById('main')?.focus();
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">{labels.skipToContent}</a>
      <div className="sidebar" data-open={menuOpen}>
        <header className="sidebar-top">
          <Wordmark />
          <Button
            variant="ghost"
            icon={menuOpen ? X : List}
            className="menu-button"
            aria-expanded={menuOpen}
            aria-controls="sidebar-body"
            ref={menuButton}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {labels.menu}
          </Button>
        </header>
        <div className="sidebar-body" id="sidebar-body">
          <nav aria-label={labels.mainNavigation}>
            <ul className="nav-list">
              {items.map((item) => (
                <li key={item.view}>
                  <button
                    type="button"
                    className="nav-item"
                    aria-current={item.view === active ? 'page' : undefined}
                    onClick={() => navigate(item.view)}
                  >
                    <Glyph icon={item.icon} size={18} />
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="account-box">
            <p className="account-name" title={userName}>{userName}</p>
            {userRole && <p className="meta">{userRole}</p>}
            <Button variant="ghost" icon={SignOut} onClick={onLogout}>{labels.logout}</Button>
          </div>
        </div>
      </div>
      <main id="main" tabIndex={-1} className="main">
        <TestStrip />
        <div className="page">{children}</div>
      </main>
    </div>
  );
}
