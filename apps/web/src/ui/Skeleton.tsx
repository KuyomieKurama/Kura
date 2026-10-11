import { labels } from '../labels.js';

/** Placeholder rows with the height of the final rows. Static, nothing animates. */
export function SkeletonRows({ count = 3, tall = false }: { count?: number; tall?: boolean }) {
  return (
    <div className="skeleton-list" role="status" aria-busy="true">
      <span className="sr-only">{labels.loading}</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={tall ? 'skeleton-row skeleton-row-tall' : 'skeleton-row'} aria-hidden="true" />
      ))}
    </div>
  );
}
