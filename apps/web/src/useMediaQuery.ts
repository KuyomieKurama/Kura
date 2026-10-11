import { useEffect, useState } from 'react';

/** True when the query matches. Without matchMedia (tests) the fallback applies, which is the desktop layout. */
export function useMediaQuery(query: string, fallback = true): boolean {
  const read = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}
