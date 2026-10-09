import { describeStatus, type StatusDomain } from '../status.js';
import { Chip } from './Chip.js';

/** The state of a download, run, post, file, transfer or user as a chip. `suffix` extends the text, for example " (Versuch 2)". */
export function StatusChip({ domain, status, suffix = '' }: { domain: StatusDomain; status: string; suffix?: string }) {
  const { tone, icon, label } = describeStatus(domain, status);
  return (
    <Chip tone={tone} icon={icon}>
      {label}
      {suffix}
    </Chip>
  );
}
