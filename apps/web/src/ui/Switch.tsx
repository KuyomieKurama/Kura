/** A switch with a visible label. `pending` is the time between the click and the answer: it cannot be clicked again. */
export function Switch({ label, checked, onChange, pending = false, disabled = false }: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      <span>{label}</span>
    </button>
  );
}
