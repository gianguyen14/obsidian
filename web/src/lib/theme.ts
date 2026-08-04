export type ThemeSetting = 'obsidian-dark' | 'obsidian-light';
export type ThemeClass = 'theme-dark' | 'theme-light';

export function normalizeTheme(value: unknown): ThemeSetting {
  return value === 'obsidian-dark' ? 'obsidian-dark' : 'obsidian-light';
}

export function themeClass(theme: ThemeSetting): ThemeClass {
  return theme === 'obsidian-dark' ? 'theme-dark' : 'theme-light';
}

export function oppositeTheme(theme: ThemeSetting): ThemeSetting {
  return theme === 'obsidian-dark' ? 'obsidian-light' : 'obsidian-dark';
}
