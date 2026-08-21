/**
 * @file src/compiler/prompt-modifiers.ts
 * @description The user-selected prompt modifiers a compile ran under, as a set
 * and as a digest.
 *
 * A modifier is a knob that changes what the page prompt ASKS FOR without
 * changing the committed prompt wording — today only the output language, set
 * by `--lang` or `LLMWIKI_OUTPUT_LANG`. Two facts follow from that, and this
 * module is the single source for both:
 *
 *  - **Change detection.** `detectChanges` classifies a source purely by the
 *    SHA-256 of its bytes, so flipping a modifier and recompiling short-circuits
 *    at "Nothing to compile" and every page keeps the wording of the previous
 *    run. The digest below travels in `state.json` so a flipped modifier
 *    invalidates the pages the modifier would have changed.
 *
 *  - **Provenance.** `PROMPT_VERSION` names the prompt IMPLEMENTATION, which is
 *    the same value whether or not a modifier was active, so it cannot tell an
 *    auditor which of two same-versioned pages was compiled under `--lang`.
 *    The set below is stamped per page to answer exactly that.
 *
 * A modifier belongs here only when it can alter compiled page CONTENT. A knob
 * that changes concurrency, output destination, or logging does not qualify:
 * recording it would invalidate pages that are byte-identical under it.
 */

import { createHash } from "node:crypto";
import { getOutputLanguage } from "../utils/output-language.js";
import type { SourceChange, WikiState } from "../utils/types.js";

/**
 * The modifiers active for this process, keyed by a stable short name.
 *
 * Empty when the operator selected none, which is the default and is what keeps
 * an untouched project from ever seeing a modifier-driven recompile.
 */
export function activePromptModifiers(): Record<string, string> {
  const modifiers: Record<string, string> = {};
  const lang = getOutputLanguage();
  if (lang) modifiers.lang = lang;
  return modifiers;
}

/**
 * A stable digest of {@link activePromptModifiers}, or `""` when none are set.
 *
 * Keys are sorted so the digest depends on the SELECTION rather than on the
 * order a future caller happens to assemble it in. `""` for the empty set — not
 * the hash of an empty string — so "no modifiers" is representable without
 * colliding with a real one, and so a project that never sets a modifier stores
 * a value that reads as absent.
 */
export function promptModifiersDigest(): string {
  const pairs = promptModifierPairs();
  if (pairs.length === 0) return "";
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

/**
 * {@link activePromptModifiers} as sorted `key=value` strings — the canonical
 * form the digest hashes AND the form stamped onto page frontmatter, so a
 * reader comparing a page's `promptModifiers` against a state digest is
 * comparing two renderings of one list rather than two independent ones.
 */
export function promptModifierPairs(): string[] {
  return Object.entries(activePromptModifiers())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
}

/**
 * Whether `recorded` (from `state.json`) describes a different modifier
 * selection than this process is running under.
 *
 * An ABSENT digest reads as "none were selected", identical to `""`. A project
 * compiled before this shipped has no recorded value, and the overwhelming
 * majority of those never set a modifier — so reading absence as "none" is both
 * true for them and free: their next compile finds no difference and recompiles
 * nothing.
 *
 * It costs exactly one recompile for the narrow case of a project that was
 * already using `--lang` when it upgraded, which is the same trade the embedding
 * store makes: an index predating fingerprints is preserved on the default path
 * and rebuilt once under an override, because the older record cannot establish
 * what produced it.
 *
 * Treating absence as "no difference" instead was the obvious alternative and is
 * WRONG: the no-op compile path never flushes state, so a project with nothing
 * to compile would never record a first digest, and the very scenario this
 * exists for — flip a modifier on a settled project — would stay silent forever.
 */
export function promptModifiersChanged(recorded: string | undefined): boolean {
  return (recorded ?? "") !== promptModifiersDigest();
}

/**
 * Promote every `unchanged` source to `changed` when the run's prompt modifiers
 * differ from the ones the last compile recorded.
 *
 * `detectChanges` classifies a source by the SHA-256 of its bytes alone, so
 * `llmwiki compile --lang Japanese` over an already-compiled project reports
 * "Nothing to compile" and leaves every page in the previous language. The
 * modifier is an input to the page prompt exactly as the source text is, so a
 * change to it invalidates the same pages.
 *
 * Scoped to `unchanged`: `new`, `changed` and `deleted` already carry the right
 * verdict, and re-labelling them would lose the distinction the buckets need.
 * Returns the list unmodified when nothing differs, so the default path
 * allocates no new verdicts.
 */
export function promoteForPromptModifiers(changes: SourceChange[], state: WikiState): SourceChange[] {
  if (!promptModifiersChanged(state.promptModifiers)) return changes;
  return changes.map((change) =>
    change.status === "unchanged" ? { ...change, status: "changed" as const } : change,
  );
}
