import { useEffect, useState } from 'react';
import { labels } from './labels.js';

type Health = { status: string };
type Status = { version: string; database: 'ok'; migrations: { appliedCount: number; latestVersion: string | null } };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [healthResponse, statusResponse] = await Promise.all([fetch('/healthz'), fetch('/api/v1/status')]);
        if (!healthResponse.ok || !statusResponse.ok) throw new Error('Request failed');
        if (active) { setHealth(await healthResponse.json()); setStatus(await statusResponse.json()); setFailed(false); setUpdated(new Date()); }
      } catch { if (active) setFailed(true); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const serviceOk = health?.status === 'ok' && !failed;
  return <main><header><h1>{labels.title}</h1><span>{labels.version} {status?.version ?? '0.1.0'}</span></header><p className="notice">{labels.notice}</p><section className="cards"><article><h2>{labels.service}</h2><p className={serviceOk ? 'ok' : 'error'}>{serviceOk ? labels.available : labels.unavailable}</p><p>{labels.databaseAvailable}: {serviceOk ? labels.available : labels.unavailable}</p><p>{labels.lastUpdated}: {updated ? updated.toLocaleTimeString('de-DE') : labels.loading}</p></article><article><h2>{labels.database}</h2><p>{labels.migrations}: {status?.migrations.appliedCount ?? '–'}</p><p>{labels.latestMigration}: {status?.migrations.latestVersion ?? '–'}</p></article></section><section><h2>Bereiche</h2><ul>{labels.areas.map((area) => <li key={area} aria-disabled="true">{area}</li>)}</ul></section></main>;
}
