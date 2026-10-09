/** German labels for the states of a download (docs/planning/04, section 4) and of the Immich handover. */
export const downloadStateLabels: Record<string, string> = {
  discovering: 'Quelle wird geprüft',
  downloading: 'Wird heruntergeladen',
  verifying: 'Wird geprüft und gespeichert',
  stored: 'Gespeichert',
  waiting_auth: 'Anmeldung erforderlich',
  waiting_rate_limit: 'Wartet wegen Ratenbegrenzung der Quelle',
  retry_wait: 'Wiederholung geplant',
  paused: 'Pausiert',
  cancelled: 'Abgebrochen',
  failed: 'Fehlgeschlagen',
  partially_completed: 'Teilweise gespeichert'
};

export const postStateLabels: Record<string, string> = {
  discovered: 'Gefunden, noch nicht geladen',
  downloading: 'Wird geladen',
  stored: 'Vollständig gespeichert',
  partially_completed: 'Teilweise gespeichert',
  failed: 'Fehlgeschlagen'
};

export const assetStateLabels: Record<string, string> = {
  pending: 'Wartet',
  downloading: 'Wird geladen',
  verifying: 'Wird geprüft',
  stored: 'Gespeichert',
  failed: 'Fehlgeschlagen'
};

export const handoverLabels: Record<string, string> = {
  not_attempted: 'Noch nicht an Immich übergeben',
  no_connection: 'Keine Immich-Verbindung',
  blocked: 'Immich-Ziel gesperrt (Freigabe durch einen Administrator nötig)',
  error: 'Übergabe an Immich fehlgeschlagen, neuer Versuch folgt',
  pending: 'Übergabe vorbereitet',
  uploading: 'Wird zu Immich hochgeladen',
  uploaded_unverified: 'Hochgeladen, Original noch nicht geprüft',
  verified: 'In Immich geprüft (Original stimmt überein)',
  mismatch: 'Abweichung in Immich festgestellt',
  failed: 'Übergabe an Immich fehlgeschlagen',
  reconciling: 'Ausgang unklar, wird abgeglichen'
};

/** Short labels for the state of an Immich transfer, as shown in a status chip. */
export const transferStateLabels: Record<string, string> = {
  pending: 'Vorbereitet',
  uploading: 'Wird hochgeladen',
  uploaded_unverified: 'Hochgeladen, nicht geprüft',
  verified: 'Verifiziert',
  mismatch: 'Abweichung',
  failed: 'Fehlgeschlagen',
  reconciling: 'Unklar, wird abgeglichen'
};

export const platformLabels: Record<string, string> = {
  direct_media: 'Direkte Medien-URL',
  youtube: 'YouTube',
  instagram: 'Instagram',
  patreon: 'Patreon',
  pixiv: 'Pixiv',
  pornhub: 'Pornhub'
};

export const availabilityLabels = {
  available: 'Verfügbar',
  unavailable: 'Nicht verfügbar',
  unknown: 'Noch nicht gemeldet'
} as const;

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unbekannt';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} ${units[unit]}`;
}
