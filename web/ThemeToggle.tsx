import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'portaflow-theme';
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = 'portaflow-' + theme;
  root.dataset.appearance = theme;
  root.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151719' : '#f7f7f3');
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => document.documentElement.dataset.appearance === 'dark' ? 'dark' : 'light');
  useEffect(() => {
    const preference = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      try { if (localStorage.getItem(STORAGE_KEY)) return; } catch { /* Use system preference when storage is unavailable. */ }
      const next = preference.matches ? 'dark' : 'light'; applyTheme(next); setTheme(next);
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      const next = event.newValue === 'dark' || event.newValue === 'light' ? event.newValue : preference.matches ? 'dark' : 'light';
      applyTheme(next); setTheme(next);
    };
    preference.addEventListener('change', update); window.addEventListener('storage', storage);
    return () => { preference.removeEventListener('change', update); window.removeEventListener('storage', storage); };
  }, []);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The toggle still works for this visit. */ }
    applyTheme(next); setTheme(next);
  };
  return <button type="button" className="btn btn-ghost btn-square theme-toggle" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggle}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>;
}
