import { Link } from '@phosphor-icons/react';
import { Glyph } from './Glyph.js';

const SEALS: Record<string, { monogram: string; label: string }> = {
  instagram: { monogram: 'Ig', label: 'Instagram' },
  patreon: { monogram: 'Pa', label: 'Patreon' },
  pixiv: { monogram: 'Px', label: 'Pixiv' },
  youtube: { monogram: 'Yt', label: 'YouTube' },
  pornhub: { monogram: 'Ph', label: 'Pornhub' }
};

export function platformName(platform: string | null | undefined): string {
  return (platform ? SEALS[platform]?.label : undefined) ?? 'Direkte Adresse';
}

/**
 * A round seal with a monogram of the platform. No brand colours and no logos: one accent, and no licence questions.
 * The platform name is always the accessible name.
 */
export function PlatformSeal({ platform, size = 'sm' }: { platform: string | null | undefined; size?: 'sm' | 'lg' }) {
  const seal = platform ? SEALS[platform] : undefined;
  return (
    <span className={size === 'lg' ? 'seal seal-lg' : 'seal'} role="img" aria-label={platformName(platform)}>
      {seal ? seal.monogram : <Glyph icon={Link} size={size === 'lg' ? 20 : 14} />}
    </span>
  );
}
