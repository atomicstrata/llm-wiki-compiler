/**
 * @file src/workflows/trusted-write.ts
 * @description The out-of-band operator grant that lets a `trust:`-gated stage
 * output AUTO-APPLY live (and so satisfy its trust gate) instead of STAGING for
 * trusted review.
 *
 * SECURITY MODEL. A `trust:` stage gate means "trusted review required": a clean,
 * well-formed stage output is NOT enough to go live — by DEFAULT it STAGES for
 * review and the gate stays UNsatisfied (closing the "valid markdown ⇒ live"
 * exploit). The ONLY way a `trust:`-gated write auto-applies is an explicit,
 * OUT-OF-WORKSPACE operator decision: the `LLMWIKI_TRUSTED_WRITE` environment
 * variable (set by the operator running the process, NOT stored in the
 * sync-controllable `.llmwiki/` workspace) lists the project(s) granted
 * auto-apply, or `*` for all.
 *
 * The grant is keyed on the active profile's `profileId` (the project's stable
 * identity). The env value is a comma/whitespace-separated list of granted
 * project ids; `*` grants every project. A grant is the operator's deliberate
 * choice to trust this project's workflow writes — never the agent's.
 */

/** The operator-set env var listing the project(s) granted trusted auto-apply. */
export const TRUSTED_WRITE_ENV_VAR = "LLMWIKI_TRUSTED_WRITE";

/** The wildcard grant value: every project is granted trusted auto-apply. */
const GRANT_ALL = "*";

/** Split the grant env value into its (trimmed, non-empty) project tokens. */
function parseGrantTokens(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Whether the operator has granted `projectId` an out-of-band TRUSTED-WRITE
 * auto-apply via {@link TRUSTED_WRITE_ENV_VAR}. Reads the env at call time (so a
 * test or operator can set it per-process); returns `false` when the var is
 * unset/blank. A `*` token grants every project; otherwise the project's id must
 * appear verbatim in the comma/whitespace-separated list.
 *
 * @param projectId - The active profile's `profileId` (the project identity).
 * @returns Whether trusted auto-apply is granted for this project.
 */
export function isTrustedWriteGranted(projectId: string): boolean {
  const raw = process.env[TRUSTED_WRITE_ENV_VAR];
  if (raw === undefined) return false;
  const tokens = parseGrantTokens(raw);
  return tokens.includes(GRANT_ALL) || tokens.includes(projectId);
}
