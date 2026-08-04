// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { applyThemeToDocument, normalizeTheme, oppositeTheme, themeClass } from './theme';

describe('theme state', () => {
  it('uses the same setting value for the sidebar toggle and appearance class', () => {
    expect(oppositeTheme('obsidian-light')).toBe('obsidian-dark');
    expect(themeClass('obsidian-dark')).toBe('theme-dark');
    expect(oppositeTheme('obsidian-dark')).toBe('obsidian-light');
    expect(themeClass('obsidian-light')).toBe('theme-light');
  });

  it('restores a persisted dark theme and safely defaults unknown values', () => {
    expect(normalizeTheme('obsidian-dark')).toBe('obsidian-dark');
    expect(normalizeTheme('unexpected')).toBe('obsidian-light');
    expect(normalizeTheme(undefined)).toBe('obsidian-light');
  });

  it('applies the palette to body for inherited text and plugin theme detection', () => {
    const body = document.createElement('body');
    body.classList.add('some-runtime-class', 'theme-light');

    applyThemeToDocument('obsidian-dark', body);

    expect(body.classList.contains('theme-dark')).toBe(true);
    expect(body.classList.contains('theme-light')).toBe(false);
    expect(body.classList.contains('some-runtime-class')).toBe(true);
    expect(body.dataset.theme).toBe('dark');

    applyThemeToDocument('obsidian-light', body);
    expect(body.classList.contains('theme-light')).toBe(true);
    expect(body.classList.contains('theme-dark')).toBe(false);
    expect(body.dataset.theme).toBe('light');
  });
});
