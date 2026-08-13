import { useEffect, useState } from 'react';

/** Phone-sized touch layout breakpoint (matches the CSS `@media (max-width: 768px)`). */
export const MOBILE_QUERY = '(max-width: 768px)';

/**
 * Tablet band: wider than a phone but narrower than a desktop pane layout.
 * Kept adjacent to `MOBILE_QUERY` so no viewport width is both "mobile" and
 * "tablet", and none falls in a gap between them.
 */
export const TABLET_QUERY = '(min-width: 769px) and (max-width: 1100px)';

/** Non-reactive one-shot check. For the plugin `Platform` shim, which is a
 * plain object read once at module load rather than a React hook. */
export function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches;
}

/** Reactive `true` when the viewport is phone-sized. Drives drawer-based mobile UI. */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}
