import { CheckCircle, Key, Warning } from '@phosphor-icons/react';
import type { AdapterCapabilities, SourceValidation } from './api.js';
import { availabilityLabels } from './history-labels.js';
import { Banner } from './ui/Banner.js';
import { Chip } from './ui/Chip.js';
import { Glyph } from './ui/Glyph.js';

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

/** The capabilities as a list of small tags, one phrase each. */
export function CapabilityTags({ capabilities }: { capabilities: AdapterCapabilities }) {
  return (
    <ul className="tag-list" aria-label="Fähigkeiten">
      {describeCapabilities(capabilities).map((phrase) => <li key={phrase}>{phrase}</li>)}
    </ul>
  );
}

/** The outcome of "Adresse prüfen": the detected platform and what the adapter can do, or a clear refusal. */
export function SourceValidationView({ result }: { result: SourceValidation }) {
  if (!result.supported) {
    return (
      <div role="group" aria-label="Ergebnis der Adressprüfung">
        <Banner tone="danger">Nicht unterstützt: {result.message}</Banner>
      </div>
    );
  }
  const { adapter } = result;
  const toolAvailable = adapter.availability === 'available';
  return (
    <div className="check-result" role="group" aria-label="Ergebnis der Adressprüfung">
      <p>
        <strong>Erkannt:</strong> {result.platformLabel} über {adapter.label}{adapter.version ? ` (Version ${adapter.version})` : ''}
      </p>
      <p className={toolAvailable ? 'tool-line tool-ok' : 'tool-line tool-warn'}>
        <Glyph icon={toolAvailable ? CheckCircle : Warning} />
        Werkzeug: {availabilityLabels[adapter.availability]}
      </p>
      {result.credentials?.loginNeeded && (
        <p>
          <Chip tone="warn" icon={Key} title="Hinterlege unter Konto, Zugänge, deine Anmeldung für diese Plattform.">Anmeldung nötig</Chip>
        </p>
      )}
      <div className="check-capabilities">
        <span>Fähigkeiten:</span>
        <CapabilityTags capabilities={result.capabilities} />
      </div>
      {result.notices.length > 0 && <ul>{result.notices.map((notice) => <li key={notice}>{notice}</li>)}</ul>}
    </div>
  );
}
