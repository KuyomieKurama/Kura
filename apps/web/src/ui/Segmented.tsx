export type SegmentOption<T extends string> = { value: T; label: string; count?: number };

/** A group of mutually exclusive options. The track is sunken, the active option is raised (surface-overlay). */
export function Segmented<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className="segmented-option" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
          {option.count !== undefined && <span className="segmented-count">{option.count}</span>}
        </button>
      ))}
    </div>
  );
}
