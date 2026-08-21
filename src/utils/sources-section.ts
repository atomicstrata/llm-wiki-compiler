/**
 * Controls whether page generation asks the model for a trailing
 * `## Sources` section.
 *
 * A compiled page already carries its provenance twice: the `sources:`
 * frontmatter list, which the compiler builds from the source files it
 * actually read rather than from anything the model writes, and the inline
 * `^[file.md:1-5]` citation markers. A project that renders either of those
 * itself ends up showing a third, redundant copy in the prose.
 *
 * Stripping the section downstream is awkward because it is not a stable
 * string: under `--lang` the model localizes that heading along with the rest
 * of the page, so a consumer has no fixed text to match on. Suppressing the
 * instruction is the only reliable way to not have it.
 *
 * Opting out is a rendering choice, not a provenance one — the frontmatter and
 * the citation markers are untouched. Unset preserves the historical prompt
 * byte-for-byte.
 */

const SOURCES_SECTION_ENV_VAR = "LLMWIKI_SOURCES_SECTION";

/**
 * Values that switch the section off, compared case-insensitively after
 * trimming. Users reach for different spellings of "no" and silently ignoring
 * three of the four would be worse than accepting all of them.
 */
const DISABLED_VALUES: ReadonlySet<string> = new Set(["0", "false", "off", "no"]);

/** True when generated pages should still include a `## Sources` section. */
export function sourcesSectionEnabled(): boolean {
  const raw = process.env[SOURCES_SECTION_ENV_VAR];
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Apply the CLI `--no-sources-section` flag into the shared env slot so the
 * prompt builder picks it up downstream.
 *
 * Commander defaults a `--no-x` option to `true`, so only an explicit `false`
 * carries the user's intent; leaving the variable alone otherwise keeps it
 * authoritative for setups that configure the project rather than a single
 * invocation. Mirrors `applyLanguageOption` in output-language.ts.
 */
export function applySourcesSectionOption(enabled: boolean | undefined): void {
  if (enabled === false) {
    process.env[SOURCES_SECTION_ENV_VAR] = "off";
  }
}
