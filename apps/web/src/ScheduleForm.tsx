import { type FormEvent, useMemo, useState } from 'react';
import { api, type PreviewEntry, type Schedule, type ScheduleRule } from './api.js';
import {
  type CronPreset,
  type IntervalUnit,
  WEEKDAYS,
  browserTimeZone,
  cronFromPreset,
  intervalSeconds,
  splitInterval,
  timeZoneOptions
} from './cron-presets.js';
import { describePreviewEntry } from './schedule-format.js';

type Mode = CronPreset | 'interval' | 'once';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Anfrage konnte nicht verarbeitet werden.';
}

function initialState(schedule?: Schedule) {
  const rule = schedule?.rule;
  const interval = rule?.kind === 'interval' ? splitInterval(rule.everySeconds) : { amount: 1, unit: 'hours' as IntervalUnit };
  return {
    mode: (rule?.kind === 'cron' ? 'custom' : rule?.kind ?? 'daily') as Mode,
    time: '06:00',
    weekday: '1',
    minute: '0',
    expression: rule?.kind === 'cron' ? rule.expression : '0 6 * * *',
    amount: String(interval.amount),
    unit: interval.unit,
    atUtc: rule?.kind === 'once' ? rule.atUtc.slice(0, 16) : '',
    timeZone: rule?.timeZone ?? browserTimeZone(),
    gapPolicy: (rule?.kind === 'cron' ? rule.gapPolicy : 'skip') as 'skip' | 'run_after_gap',
    jitter: String(schedule?.jitterMaxSeconds ?? 0)
  };
}

/** Creates or edits one schedule: simple presets for the common cases, raw cron for advanced users. */
export function ScheduleForm({ subscriptionId, schedule, onSaved, onCancel }: {
  subscriptionId: string;
  schedule?: Schedule;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState(() => initialState(schedule));
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PreviewEntry[] | null>(null);
  const zones = useMemo(() => {
    const all = timeZoneOptions();
    return all.includes(state.timeZone) ? all : [state.timeZone, ...all];
  }, [state.timeZone]);
  const set = <K extends keyof typeof state>(key: K, value: (typeof state)[K]) => {
    setState((current) => ({ ...current, [key]: value }));
    setPreview(null);
  };

  /** Returns the rule, or a message when the form is not complete. */
  function buildRule(): ScheduleRule | string {
    const { mode, timeZone } = state;
    if (mode === 'interval') {
      const amount = Number(state.amount);
      if (!Number.isInteger(amount) || amount < 1) return 'Bitte geben Sie ein ganzzahliges Intervall ab 1 an.';
      const existing = schedule?.rule.kind === 'interval' ? schedule.rule : undefined;
      return { kind: 'interval', everySeconds: intervalSeconds(amount, state.unit), timeZone, ...(existing ? { anchorUtc: existing.anchorUtc } : {}) };
    }
    if (mode === 'once') {
      return state.atUtc ? { kind: 'once', atUtc: `${state.atUtc}:00Z`, timeZone } : 'Bitte geben Sie den Zeitpunkt an.';
    }
    const expression = mode === 'custom' ? state.expression.trim() : cronFromPreset(mode, state);
    if (!expression) return 'Bitte geben Sie eine gültige Uhrzeit an.';
    return { kind: 'cron', expression, timeZone, gapPolicy: state.gapPolicy };
  }

  async function showPreview() {
    const rule = buildRule();
    if (typeof rule === 'string') { setError(rule); return; }
    try {
      setError('');
      setPreview((await api.previewSchedule(rule, 5)).entries);
    } catch (cause) {
      setPreview(null);
      setError(errorMessage(cause));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rule = buildRule();
    if (typeof rule === 'string') { setError(rule); return; }
    const jitterMaxSeconds = Number(state.jitter);
    if (!Number.isInteger(jitterMaxSeconds) || jitterMaxSeconds < 0 || jitterMaxSeconds > 3600) {
      setError('Die Startverzögerung muss zwischen 0 und 3600 Sekunden liegen.');
      return;
    }
    try {
      if (schedule) await api.updateSchedule(schedule.id, { rule, jitterMaxSeconds });
      else await api.createSchedule({ subscriptionId, rule, jitterMaxSeconds });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const isCron = state.mode !== 'interval' && state.mode !== 'once';
  return <form onSubmit={submit} aria-label={schedule ? 'Zeitplan bearbeiten' : 'Zeitplan anlegen'}>
    <label>Art des Zeitplans
      <select value={state.mode} onChange={(event) => set('mode', event.target.value as Mode)}>
        <option value="daily">Täglich</option>
        <option value="weekdays">Montag bis Freitag</option>
        <option value="weekly">Wöchentlich</option>
        <option value="hourly">Stündlich</option>
        <option value="interval">Festes Intervall</option>
        <option value="once">Einmalig</option>
        <option value="custom">Eigener Cron-Ausdruck</option>
      </select>
    </label>
    {(state.mode === 'daily' || state.mode === 'weekdays' || state.mode === 'weekly') &&
      <label>Uhrzeit<input type="time" value={state.time} onChange={(event) => set('time', event.target.value)} required /></label>}
    {state.mode === 'weekly' &&
      <label>Wochentag
        <select value={state.weekday} onChange={(event) => set('weekday', event.target.value)}>
          {WEEKDAYS.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}
        </select>
      </label>}
    {state.mode === 'hourly' &&
      <label>Minute der Stunde<input type="number" min="0" max="59" value={state.minute} onChange={(event) => set('minute', event.target.value)} required /></label>}
    {state.mode === 'custom' && <>
      <label>Cron-Ausdruck (fünf Felder)<input value={state.expression} onChange={(event) => set('expression', event.target.value)} spellCheck={false} required /></label>
      <p>Minute Stunde Tag Monat Wochentag, zum Beispiel <code>30 2 * * 1-5</code>.</p>
    </>}
    {state.mode === 'interval' && <>
      <label>Alle<input type="number" min="1" value={state.amount} onChange={(event) => set('amount', event.target.value)} required /></label>
      <label>Einheit
        <select value={state.unit} onChange={(event) => set('unit', event.target.value as IntervalUnit)}>
          <option value="minutes">Minuten</option>
          <option value="hours">Stunden</option>
          <option value="days">Tage</option>
        </select>
      </label>
      <p>Ein Intervall zählt die verstrichene Zeit und folgt keiner Zeitumstellung. Mindestens 1 Minute.</p>
    </>}
    {state.mode === 'once' &&
      <label>Zeitpunkt (UTC)<input type="datetime-local" value={state.atUtc} onChange={(event) => set('atUtc', event.target.value)} required /></label>}
    <label>Zeitzone
      <select value={state.timeZone} onChange={(event) => set('timeZone', event.target.value)}>
        {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
      </select>
    </label>
    {isCron && <>
      <label>Fehlende Uhrzeit bei Zeitumstellung
        <select value={state.gapPolicy} onChange={(event) => set('gapPolicy', event.target.value as 'skip' | 'run_after_gap')}>
          <option value="skip">Termin überspringen (Standard)</option>
          <option value="run_after_gap">Direkt nach der Lücke ausführen</option>
        </select>
      </label>
      <p>Im Frühjahr fehlt eine Stunde. Standardmäßig entfällt ein Termin in dieser Stunde; die Vorschau zeigt das an.</p>
    </>}
    <label>Startverzögerung zur Lastverteilung (Sekunden, 0 bis 3600)
      <input type="number" min="0" max="3600" value={state.jitter} onChange={(event) => set('jitter', event.target.value)} required />
    </label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button type="button" className="secondary" onClick={() => void showPreview()}>Vorschau der nächsten Läufe</button>
    {preview && <section aria-label="Vorschau der nächsten Läufe">
      <h4>Nächste Läufe</h4>
      {preview.length === 0 ? <p>Diese Regel löst nicht mehr aus.</p> : <ol>{preview.map((entry, index) => <li key={index}>{describePreviewEntry(entry)}</li>)}</ol>}
    </section>}
    <button>Speichern</button>
    <button type="button" className="secondary" onClick={onCancel}>Abbrechen</button>
  </form>;
}
