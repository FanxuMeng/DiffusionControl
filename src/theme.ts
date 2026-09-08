export type Theme = 'light' | 'dark';
const THEME_KEY = 'diffusioncontrol.ui.theme';

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Browser privacy settings may disable preference storage. */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171b20' : '#f3f5f7');
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch { /* Keep the current session usable. */ } }
}
