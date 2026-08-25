/**
 * @file src/compiler/prompt-modifiers.ts
 * @description The user-selected prompt modifiers a compile ran under, as a set
 * and as a digest.
 *
 * A modifier is a knob that changes what the page prompt ASKS FOR without
 * changing the committed prompt wording: the output language, set by `--lang`
 * or `LLMWIKI_OUTPUT_LANG`, and the caller policy passed to `compile`. Two facts follow from that, and this
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

import { AsyncLocalStorage } from "node:async_hooks";
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
  const policy = activeSystemPolicy();
  if (policy) modifiers.policy = sha256(policy);
  return modifiers;
}

/**
 * The caller policy for the current async call tree.
 *
 * `AsyncLocalStorage` rather than a module variable, matching `quietScope` and
 * `verboseScope` in utils/output.ts. The SDK documents that "concurrent calls
 * are fully isolated" with "no global state" (docs/guides/sdk.mdx), and the
 * compile lock is per ROOT, so two SDK callers compiling different projects
 * genuinely overlap in one process.
 *
 * A save-and-restore module variable does NOT survive that. It handles nesting
 * and fails on interleaving: the run that finishes first restores the value it
 * captured, which belongs to neither run. Measured on the earlier
 * implementation, two overlapping runs observed `["Policy B", undefined]` where
 * they should observe `["Policy A", "Policy B"]` — one project reading another's
 * policy, and the other losing its own.
 *
 * That matters beyond the prompt text: the policy feeds the modifier digest, so
 * a leak writes one project's selection into another's `state.json`, its
 * candidates, and its page provenance.
 *
 * An env slot was the other option and is worse: `systemPolicy` is an SDK
 * option and nothing else, so it would mean documenting a variable that exists
 * only to carry a value across module boundaries — and env is process-global,
 * which is the same bug.
 */
const policyScope = new AsyncLocalStorage<string | undefined>();

/**
 * Run `fn` with `policy` as the active caller policy, restoring the previous
 * value afterwards even if `fn` throws.
 *
 * Blank and whitespace-only policies are normalised to `undefined` HERE, once,
 * so every downstream reader (the digest, the frontmatter stamp, the prompt
 * builders) agrees on what "no policy" means without each re-deciding.
 */
export function withRunSystemPolicy<T>(policy: string | undefined, fn: () => T): T {
  const trimmed = policy?.trim();
  return policyScope.run(trimmed && trimmed.length > 0 ? trimmed : undefined, fn);
}

/** The active caller policy, already trimmed, or `undefined` when none is set. */
export function activeSystemPolicy(): string | undefined {
  return policyScope.getStore();
}

/**
 * The policy's DIGEST rather than its text is what enters the modifier set.
 *
 * A policy is caller-authored prose of unbounded length, and the modifier set is
 * hashed into `state.json`, stamped onto every page's frontmatter, and published
 * through the JSON export. Carrying the text would put an operator's editorial
 * instructions into three artifacts that outlive the run, one of them shipped to
 * downstream consumers. The digest answers the only question the mechanism asks
 * of it: is this the same policy as last time?
 */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
