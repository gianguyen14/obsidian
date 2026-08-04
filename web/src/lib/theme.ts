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

/**
 * Obsidian applies its theme class to <body>. Besides making the palette
 * available to every UI surface, community plugins use the body class and
 * data-theme attribute to detect the active colour scheme.
 */
export function applyThemeToDocument(theme: ThemeSetting, body = document.body): void {
  const activeClass = themeClass(theme);
  body.classList.remove('theme-light', 'theme-dark');
  body.classList.add(activeClass);
  body.dataset.theme = theme === 'obsidian-dark' ? 'dark' : 'light';
}
