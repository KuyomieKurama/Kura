import { labels } from './labels.js';

/** The text of a failed request, or the generic German fallback. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : labels.requestError;
}
