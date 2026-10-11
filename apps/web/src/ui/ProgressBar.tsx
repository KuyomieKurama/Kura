/** 4px bar with round ends. The only round shape outside the radius scale. Announced as a progressbar. */
export function ProgressBar({ value, max, label, width }: { value: number; max: number; label: string; width?: number }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      style={width ? { width } : undefined}
    >
      <div className="progress-fill" style={{ width: `${Math.round(ratio * 1000) / 10}%` }} />
    </div>
  );
}
