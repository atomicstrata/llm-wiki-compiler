/**
 * The colour theme: follow the system, or force light or dark.
 *
 * The choice is kept in `localStorage` and applied as `data-theme` on the
 * document element, which `styles.css` reads. Storage can be unavailable in a
 * private window, so every read and write is guarded and the page still works
 * without it.
 */
import { useEffect, useState } from "react";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
const STORAGE_KEY = "llmwiki-v2-theme";

/** The stored theme, or `system` when nothing valid is stored. */
function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : "system";
  } catch {
    return "system";
  }
}

/** Apply a theme to the document and remember it. */
function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Nothing to do: the theme still applies for this page load.
  }
}

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** The current theme and a setter that applies and stores it. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return [theme, setTheme];
}
