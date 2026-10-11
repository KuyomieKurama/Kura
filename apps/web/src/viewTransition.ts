import { flushSync } from 'react-dom';

/** The name shared by the tile that was clicked and the frame of the viewer, so the browser can morph one into the other. */
export const VIEWER_TRANSITION_NAME = 'viewer-media';

/** Set on the document while the opening transition runs. The viewer reads it once, when it mounts, to skip its fade. */
export const TRANSITION_ATTRIBUTE = 'data-view-transition';

interface Transitioning {
  startViewTransition?: (update: () => void) => { finished: Promise<unknown> };
}

const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Opens the viewer. With the View Transition API (and without reduced motion) the clicked tile morphs into the viewer
 * in 240ms; everywhere else the update runs at once and the viewer fades in by itself (160ms, see media.css).
 */
export function openViewer(opener: HTMLElement | null | undefined, update: () => void): void {
  const doc = document as Document & Transitioning;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  const source = opener?.querySelector<HTMLElement>('img') ?? opener ?? null;
  const root = document.documentElement;
  const finish = () => {
    source?.style.removeProperty('view-transition-name');
    root.removeAttribute(TRANSITION_ATTRIBUTE);
  };
  source?.style.setProperty('view-transition-name', VIEWER_TRANSITION_NAME);
  root.setAttribute(TRANSITION_ATTRIBUTE, 'viewer');
  try {
    const transition = doc.startViewTransition(() => {
      flushSync(update);
      // The tile stays on the page behind the viewer; only one element may carry the name in the new state.
      source?.style.removeProperty('view-transition-name');
    });
    void transition.finished.then(finish, finish);
  } catch {
    finish();
    update();
  }
}

/** Whether the viewer is being opened by a view transition (read once at mount; otherwise it fades in). */
export const openedByTransition = (): boolean => document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE);
