/**
 * Resolve the closed viewer theme registry before the first stylesheet loads.
 * A new preference wins over the legacy light/dark key. Only absent new keys
 * migrate, and storage failures never prevent a readable first paint.
 * The DOM binding uses this same controller to avoid duplicated validation.
 */
(function () {
  const STORAGE_KEY = "llmwiki.viewer.theme.v1";
  const LEGACY_KEY = "llmwiki-viewer-theme";
  const DEFAULT_THEME = "scientific-clay";
  const MAX_ID_LENGTH = 32;
  const THEME_IDS = new Set([DEFAULT_THEME, "minimal", "nebula-light", "nebula-dark"]);

  /** Resolve unknown and malformed IDs to the safe built-in default. */
  function validate(value) {
    return typeof value === "string" && value.length <= MAX_ID_LENGTH && THEME_IDS.has(value)
      ? value : DEFAULT_THEME;
  }

  /** Persist best-effort; the document can still switch without storage. */
  function persist(theme) {
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch { /* Session-only. */ }
  }

  /** Migrate only when the new preference key is absent. */
  function migrateLegacy() {
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (!["light", "dark"].includes(legacy)) return DEFAULT_THEME;
    const migrated = `nebula-${legacy}`;
    persist(migrated);
    return migrated;
  }

  /** Preserve explicit old light/dark selections without changing the old key. */
  function storedTheme() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored === null ? migrateLegacy() : validate(stored);
    } catch { return DEFAULT_THEME; }
  }

  /** Apply an allowed palette without rerendering routes or graph state. */
  function apply(value) {
    const theme = validate(value);
    document.documentElement.dataset.theme = theme;
    return theme;
  }

  /** Commit a user selection, keeping persistence failure non-fatal. */
  function select(value) {
    const theme = apply(value);
    persist(theme);
    return theme;
  }

  window.__llmwikiTheme = Object.freeze({ select });
  apply(storedTheme());
})();
