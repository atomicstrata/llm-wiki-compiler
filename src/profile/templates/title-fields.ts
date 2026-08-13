/**
 * @file src/profile/templates/title-fields.ts
 * @description Deriving a builtin template's PRE-`titleField` release.
 *
 * Lives OUTSIDE `builtin/` on purpose. That directory is the template-DATA
 * allowlist `test/profile-template-genericity.test.ts` enumerates — the only
 * files permitted to name a template's vocabulary — and this helper names none:
 * it is a shape transform every template happens to need. Adding it to the data
 * allowlist would blunt what that allowlist means.
 *
 * Both shipped non-default templates gained a `titleField` per entity type in
 * the same change, and both therefore advance a version and must retain their
 * predecessor. Retention is load-bearing rather than ceremonial:
 * `planTemplateUpdate` resolves the INSTALLED release and compares its
 * `profileDigest` against the on-disk profile to decide whether a project
 * carries local modifications. So a dropped predecessor makes
 * `planBuiltinTemplateUpdate` throw for every project still on it, and a
 * retained predecessor that had silently gained `titleField` would report every
 * such project as locally modified.
 *
 * The predecessor's entity block is DERIVED rather than frozen as a second copy
 * of every type. The title declarations are the only difference between the two
 * releases, so a frozen duplicate would be a second thing to keep correct — and
 * the derivation is checked, not trusted: each template's tests pin the derived
 * `profileDigest` to the digest that release actually published, computed from
 * the pre-change source. A later edit to the current entities that leaks into a
 * retained release fails there rather than quietly mis-describing an installed
 * project.
 */

import type { ProfilePack } from "../types.js";

/**
 * The same entity block with every `titleField` declaration removed.
 *
 * @param entities - The CURRENT release's entity block.
 * @returns The block as the pre-`titleField` release published it.
 */
export function withoutTitleFields(entities: ProfilePack["entities"]): ProfilePack["entities"] {
  return Object.fromEntries(
    Object.entries(entities).map(([type, def]) => {
      const { titleField: _dropped, ...rest } = def;
      return [type, rest];
    }),
  );
}
