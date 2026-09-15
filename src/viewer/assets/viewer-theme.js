/**
 * Bind the labeled native theme selector to the pre-paint controller.
 * Resolution and persistence stay in viewer-theme-boot.js; this module only
 * reflects the already selected palette and wires user changes once mounted.
 */

/** Wire theme selection without navigation, fetching, or graph reconstruction. */
export function wireThemeSelect() {
  const select = document.querySelector("[data-theme-select]");
  if (!select) return;
  select.value = document.documentElement.dataset.theme;
  select.addEventListener("change", () => {
    select.value = window.__llmwikiTheme.select(select.value);
  });
}
