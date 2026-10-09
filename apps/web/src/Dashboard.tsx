import { ArrowRight, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { labels } from './labels.js';
import { Banner } from './ui/Banner.js';
import { Chip } from './ui/Chip.js';
import { Glyph } from './ui/Glyph.js';
import { PageHeader } from './ui/PageHeader.js';

export type ServiceStatus = { version: string; migrations: { appliedCount: number; latestVersion: string | null } };
export type HealthState = 'loading' | 'ok' | 'error';

const quickLinks = [
  { view: 'subscriptions', title: labels.subscriptions, description: labels.quickSubscriptions },
  { view: 'history', title: labels.history, description: labels.quickHistory },
  { view: 'immich', title: labels.immich, description: labels.quickImmich }
];

function formatTime(date: Date): string {
  return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Status of the service as a plain definition list, then links to the main areas. Only data the API already provides. */
export function Dashboard({ health, status, checkedAt, onNavigate }: {
  health: HealthState;
  status: ServiceStatus | null;
  checkedAt: Date | null;
  onNavigate: (view: string) => void;
}) {
  const unknown = health === 'loading';
  return (
    <>
      <PageHeader title={labels.overview} />
      {health === 'error' && (
        <Banner tone="danger">
          <strong>{labels.statusError}</strong> {labels.statusErrorAction}
        </Banner>
      )}
      <section className="section" aria-labelledby="status-heading">
        <h2 id="status-heading">{labels.systemStatus}</h2>
        <dl className="status-list">
          <div className="status-item">
            <dt>{labels.service}</dt>
            <dd>
              {unknown
                ? <span className="skeleton-inline" aria-hidden="true" />
                : health === 'ok'
                  ? <Chip tone="ok" icon={CheckCircle}>{labels.available}</Chip>
                  : <Chip tone="danger" icon={WarningCircle}>{labels.unavailable}</Chip>}
            </dd>
          </div>
          <div className="status-item">
            <dt>{labels.version}</dt>
            <dd className="mono">{status?.version ?? labels.unknown}</dd>
          </div>
          <div className="status-item">
            <dt>{labels.databaseAvailable}</dt>
            <dd>{unknown ? labels.unknown : health === 'ok' ? labels.yes : labels.no}</dd>
          </div>
          <div className="status-item">
            <dt>{labels.migrations}</dt>
            <dd className="num">{status?.migrations.appliedCount ?? labels.unknown}</dd>
          </div>
          <div className="status-item">
            <dt>{labels.latestMigration}</dt>
            <dd className="mono">{status?.migrations.latestVersion ?? labels.unknown}</dd>
          </div>
          <div className="status-item">
            <dt>{labels.lastUpdated}</dt>
            <dd className="num">{checkedAt ? formatTime(checkedAt) : labels.unknown}</dd>
          </div>
        </dl>
      </section>
      <section className="section" aria-labelledby="quick-heading">
        <h2 id="quick-heading">{labels.quickLinks}</h2>
        <ul className="quick-links">
          {quickLinks.map((link) => (
            <li key={link.view}>
              <button type="button" className="quick-link" onClick={() => onNavigate(link.view)}>
                <span className="quick-link-text">
                  <span className="quick-link-title">{link.title}</span>
                  <span className="meta">{link.description}</span>
                </span>
                <Glyph icon={ArrowRight} size={18} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
