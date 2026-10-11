import { CheckCircle } from '@phosphor-icons/react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Glyph } from './Glyph.js';

type ToastInput = { message: string; action?: { label: string; onAction: () => void } };
type ToastEntry = ToastInput & { id: number };

const TOAST_MS = 6000;
const MAX_TOASTS = 3;

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined);

export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext);
}

function ToastItem({ toast, dismiss }: { toast: ToastEntry; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => setLeaving(true), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [paused]);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => dismiss(toast.id), 200);
    return () => window.clearTimeout(timer);
  }, [leaving, dismiss, toast.id]);
  return (
    <div
      className="toast"
      data-leaving={leaving}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Glyph icon={CheckCircle} size={18} />
      <p>{toast.message}</p>
      {toast.action && (
        <button type="button" className="btn btn-ghost" onClick={() => { toast.action?.onAction(); dismiss(toast.id); }}>
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/** Toasts for success and neutral messages only. An error is a banner where it happened, never a toast. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const next = useRef(1);
  const show = useCallback((toast: ToastInput) => {
    setToasts((current) => [...current, { ...toast, id: next.current++ }].slice(-MAX_TOASTS));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} dismiss={dismiss} />)}
      </div>
    </ToastContext.Provider>
  );
}
