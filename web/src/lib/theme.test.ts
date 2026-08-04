import { describe, expect, it } from 'vitest';
import { normalizeTheme, oppositeTheme, themeClass } from './theme';

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
});
