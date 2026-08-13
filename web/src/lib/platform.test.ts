// @vitest-environment happy-dom

/**
 * The plugin `Platform` shim used to hardcode `max-width: 700px` while the rest
 * of the app switched to its phone layout at 768px (`useIsMobile.ts`). Plugins
 * were therefore told `isDesktop` on a 701-768px viewport that was actually
 * rendering the mobile drawer UI. These tests pin the two to one breakpoint so
 * they cannot drift apart again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectNativeShell } from './nativeShell';
import { MOBILE_QUERY, TABLET_QUERY, isMobileViewport } from './useIsMobile';

/** Minimal `matchMedia` that evaluates width queries against a fixed viewport. */
function stubViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
    return { matches, media: query, addEventListener() {}, removeEventListener() {} };
  });
  // `isMobileViewport` reads `window.matchMedia`, not the bare global.
  vi.stubGlobal('window', { ...globalThis.window, matchMedia: globalThis.matchMedia });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mobile breakpoint', () => {
  it('treats the 701-768px band as mobile, not desktop', () => {
    // The exact regression: 700px-based code called this desktop.
    stubViewport(760);
    expect(isMobileViewport()).toBe(true);
  });

  it('is mobile at and below 768px, desktop above', () => {
    stubViewport(768);
    expect(isMobileViewport()).toBe(true);
    stubViewport(769);
    expect(isMobileViewport()).toBe(false);
  });

  it('leaves no gap or overlap between the mobile and tablet bands', () => {
    stubViewport(769);
    expect(isMobileViewport()).toBe(false);
    expect(matchMedia(TABLET_QUERY).matches).toBe(true);

    stubViewport(768);
    expect(isMobileViewport()).toBe(true);
    expect(matchMedia(TABLET_QUERY).matches).toBe(false);
  });

  it('derives both queries from the same 768px breakpoint', () => {
    // Guards against someone editing one string and not the other.
    expect(MOBILE_QUERY).toContain('768px');
    expect(TABLET_QUERY).toContain('769px');
  });
});

describe('native shell detection', () => {
  it('reports no shell in a plain browser', () => {
    expect(detectNativeShell()).toBe(null);
  });

  it('reports mobile when Capacitor says it is running natively', () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
    expect(detectNativeShell()).toBe('mobile');
  });

  it('ignores Capacitor when it reports a web (non-native) platform', () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => false } });
    expect(detectNativeShell()).toBe(null);
  });

  it('reports desktop when the Electron preload marks the shell', () => {
    vi.stubGlobal('window', { __webobsidianShell: 'desktop' });
    expect(detectNativeShell()).toBe('desktop');
  });

  it('ignores an unrecognised shell value rather than trusting it', () => {
    vi.stubGlobal('window', { __webobsidianShell: 'something-else' });
    expect(detectNativeShell()).toBe(null);
  });
});
