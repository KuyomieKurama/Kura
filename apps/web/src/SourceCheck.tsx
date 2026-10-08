import type { AdapterCapabilities, SourceValidation } from './api.js';
import { availabilityLabels } from './history-labels.js';

/** What an adapter can do, as short German phrases. Only declared capabilities are listed. */
export function describeCapabilities(capabilities: AdapterCapabilities): string[] {
  const phrases: string[] = [];
  phrases.push(capabilities.singlePost ? 'Einzelner Beitrag' : '');
  phrases.push(capabilities.creatorFeed ? 'Ganzer Kanal oder Creator' : 'Kein ganzer Kanal, keine Playlist');
  if (capabilities.images) phrases.push('Bilder');
  if (capabilities.videos) phrases.push('Videos');
  if (capabilities.pagination) phrases.push('Seitenweise Abruf');
  if (capabilities.resume) phrases.push('Fortsetzen abgebrochener Downloads');
  if (capabilities.pageSnapshot) phrases.push('Seiten-Schnappschuss');
  if (capabilities.qualityVariants) phrases.push('Qualitätsstufen');
  phrases.push(`Anmeldung: ${capabilities.authLabel}`);
  return phrases.filter(Boolean);
}

/** The outcome of "Adresse prüfen": the detected platform and what the adapter can do, or a clear refusal. */
export function SourceValidationView({ result }: { result: SourceValidation }) {
  if (!result.supported) {
    return <div aria-label="Ergebnis der Adressprüfung">
      <p className="form-error" role="alert">Nicht unterstützt: {result.message}</p>
    </div>;
  }
  const { adapter } = result;
  return <div aria-label="Ergebnis der Adressprüfung">
    <p><strong>Erkannt:</strong> {result.platformLabel} über {adapter.label}{adapter.version ? ` (Version ${adapter.version})` : ''}</p>
    <p>Werkzeug: {availabilityLabels[adapter.availability]}</p>
    <p>Fähigkeiten: {describeCapabilities(result.capabilities).join(' · ')}</p>
    {result.notices.length > 0 && <ul>{result.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>}
  </div>;
}
