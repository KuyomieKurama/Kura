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

/** The skeleton of the subscription list: cover square, two text bars, a number bar and the shape of a button. */
export function SkeletonSubscriptions({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-busy="true">
      <span className="sr-only">{labels.loading}</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="skeleton-sub" aria-hidden="true">
          <span className="skeleton-block skeleton-cover" />
          <span className="skeleton-lines"><span className="skeleton-block skeleton-bar" /><span className="skeleton-block skeleton-bar skeleton-bar-short" /></span>
          <span className="skeleton-block skeleton-bar skeleton-number" />
          <span className="skeleton-block skeleton-button" />
        </div>
      ))}
    </div>
  );
}
