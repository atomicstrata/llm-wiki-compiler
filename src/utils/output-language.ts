/**
 * Output-language configuration for LLM-generated wiki content (issue #37).
 *
 * Resolves the user's chosen target language for compile and query
 * prompts. The CLI's `--lang <code>` flag and the `LLMWIKI_OUTPUT_LANG`
 * environment variable both write into the same env slot, so prompt
 * builders only need to read one source of truth.
 *
 * When unset, the resolver returns null — preserving the historical
 * behaviour where the LLM follows its own default (typically the
 * source-document language, often English).
 */

const LANG_ENV_VAR = "LLMWIKI_OUTPUT_LANG";

/**
 * Read the configured output language. Returns null when the user has
 * not opted into a specific target language.
 */
export function getOutputLanguage(): string | null {
  const raw = process.env[LANG_ENV_VAR];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build the language-directive line to inject into a system prompt.
 * Returns an empty string when no language is configured, which lets
 * callers concatenate unconditionally without producing an extra blank
 * line in the default case.
 */
export function languageDirective(): string {
  const lang = getOutputLanguage();
  if (!lang) return "";
  return `Write the output in ${lang}.`;
}

/**
 * Apply a CLI `--lang <code>` value into the shared env slot so prompt
 * builders pick it up downstream. No-op when the caller did not pass the
 * flag. Trims whitespace so accidental padding does not leak into the
 * language directive.
 *
 * Lives in this module (not cli.ts) so every CLI verb plus the upcoming
 * quickstart command share one implementation and the resolution order
 * cannot drift between them.
 */
export function applyLanguageOption(lang: string | undefined): void {
  if (lang && lang.trim().length > 0) {
    process.env.LLMWIKI_OUTPUT_LANG = lang.trim();
  }
}
