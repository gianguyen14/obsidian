/**
 * Which native shell, if any, is hosting this SPA.
 *
 * Desktop (Electron) and mobile (Capacitor) both load this exact same build
 * straight from the server origin — that is what keeps every request
 * same-origin and is why no API base-URL indirection is needed. Since there is
 * no separate build per target, the shell announces itself with a global:
 *
 *  - Electron: the preload sets `__webobsidianShell = 'desktop'`.
 *  - Capacitor: injects its own `Capacitor` global before page scripts run.
 *
 * A plain browser has neither, so both flags are `false`.
 */
export type NativeShell = 'desktop' | 'mobile' | null;

export function detectNativeShell(): NativeShell {
  if (typeof window === 'undefined') return null;
  const declared = (window as unknown as { __webobsidianShell?: unknown }).__webobsidianShell;
  if (declared === 'desktop' || declared === 'mobile') return declared;
  const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  if (capacitor?.isNativePlatform?.()) return 'mobile';
  return null;
}
