import type { Icon } from '@phosphor-icons/react';
import {
  ArrowsClockwise,
  CheckCircle,
  CircleDashed,
  CircleHalf,
  Clock,
  DownloadSimple,
  Hourglass,
  LockKey,
  MagnifyingGlass,
  PauseCircle,
  Play,
  Prohibit,
  Question,
  SealCheck,
  ShieldCheck,
  UploadSimple,
  Warning,
  WarningCircle,
  XCircle
} from '@phosphor-icons/react';
import { labels } from './labels.js';
import { assetStateLabels, availabilityLabels, downloadStateLabels, postStateLabels, targetStateLabels, transferStateLabels } from './history-labels.js';
import { runStateLabels } from './schedule-format.js';

/**
 * The one place that decides how a state looks: which colour family and which icon.
 * Colour is never the only carrier of meaning, every chip shows its icon and its German text.
 */
export type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';

/** Where a state comes from. The same key looks the same in every domain. */
export type StatusDomain = 'download' | 'run' | 'post' | 'asset' | 'transfer' | 'user' | 'target' | 'availability' | 'credential';

type Appearance = { tone: Tone; icon: Icon };

const appearance: Record<string, Appearance> = {
  // Downloads, runs and posts
  queued: { tone: 'neutral', icon: Clock },
  leased: { tone: 'accent', icon: Play },
  discovered: { tone: 'neutral', icon: MagnifyingGlass },
  discovering: { tone: 'accent', icon: MagnifyingGlass },
  downloading: { tone: 'accent', icon: DownloadSimple },
  verifying: { tone: 'accent', icon: ShieldCheck },
  stored: { tone: 'ok', icon: CheckCircle },
  succeeded: { tone: 'ok', icon: CheckCircle },
  waiting_auth: { tone: 'warn', icon: LockKey },
  waiting_rate_limit: { tone: 'warn', icon: Hourglass },
  retry_wait: { tone: 'warn', icon: ArrowsClockwise },
  paused: { tone: 'neutral', icon: PauseCircle },
  cancelled: { tone: 'neutral', icon: XCircle },
  failed: { tone: 'danger', icon: WarningCircle },
  partially_completed: { tone: 'warn', icon: CircleHalf },
  // Assets
  pending: { tone: 'neutral', icon: CircleDashed },
  // Immich transfer and handover
  uncertain: { tone: 'warn', icon: Question },
  reconciling: { tone: 'warn', icon: Question },
  uploading: { tone: 'accent', icon: UploadSimple },
  uploaded_unverified: { tone: 'warn', icon: UploadSimple },
  verified: { tone: 'ok', icon: SealCheck },
  mismatch: { tone: 'danger', icon: WarningCircle },
  // Subscriptions, their target address and the tools behind adapters
  unvalidated: { tone: 'neutral', icon: Question },
  valid: { tone: 'ok', icon: CheckCircle },
  invalid: { tone: 'danger', icon: WarningCircle },
  available: { tone: 'ok', icon: CheckCircle },
  unavailable: { tone: 'warn', icon: Warning },
  unknown: { tone: 'neutral', icon: Question },
  // Stored platform cookies ("stored" looks like the other stored states)
  auth_required: { tone: 'warn', icon: LockKey },
  expired: { tone: 'warn', icon: Hourglass },
  // Users
  active: { tone: 'ok', icon: CheckCircle },
  blocked: { tone: 'danger', icon: Prohibit }
};

const fallback: Appearance = { tone: 'neutral', icon: Warning };

const labelTables: Record<StatusDomain, Record<string, string>> = {
  download: downloadStateLabels,
  run: runStateLabels,
  post: postStateLabels,
  asset: assetStateLabels,
  transfer: transferStateLabels,
  user: { active: labels.active, blocked: labels.blocked },
  target: targetStateLabels,
  availability: availabilityLabels,
  credential: { stored: 'Cookies hinterlegt', auth_required: 'Anmeldung abgelaufen', expired: 'Cookies abgelaufen' }
};

export function describeStatus(domain: StatusDomain, status: string): Appearance & { label: string } {
  return {
    ...(appearance[status] ?? fallback),
    label: labelTables[domain][status] ?? downloadStateLabels[status] ?? runStateLabels[status] ?? status
  };
}

/** Segment colour in the history ledger: one segment per file. */
export function assetSegmentTone(state: string): Tone {
  return (appearance[state] ?? fallback).tone;
}
