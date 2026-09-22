/** Member-bearing profile policy, separated from unrelated entity validation. */
import type { ArtifactTypeDef } from "./types.js";
import { assert } from "./validate-helpers.js";
import { isSafeFilenameComponent } from "./identity.js";
import { MAX_ARTIFACT_MEMBERS, MAX_ARTIFACT_MEMBER_BYTES } from "../artifacts/name.js";
import { isReservedMemberName, memberAliasKey, memberNamePolicyViolations } from "../artifacts/members.js";

/**
 * Semantic checks over a member-bearing declaration: json only, exclusive with
 * `metadata` (v1), ceilings within the store's hard caps and mutually
 * consistent, extensions in `.ext` form, required names that are themselves
 * acceptable members (safe, unreserved, policy-conforming), and `exactNames`
 * only over a non-empty required set — every rule a write or read would
 * otherwise discover as an unsatisfiable type.
 */
export function assertMembersDef(id: string, def: ArtifactTypeDef): void {
  const where = `artifact ${JSON.stringify(id)} members`;
  const members = def.members!;
  assert(def.contentKind === "json", `${where} is permitted only when contentKind is "json"`);
  assert(def.metadata === undefined, `${where} and metadata are mutually exclusive`);
  assert(members.maxCount >= 1 && members.maxCount <= MAX_ARTIFACT_MEMBERS, `${where}.maxCount must be in 1..${MAX_ARTIFACT_MEMBERS}`);
  assert(members.maxMemberBytes >= 1 && members.maxMemberBytes <= MAX_ARTIFACT_MEMBER_BYTES, `${where}.maxMemberBytes must be in 1..${MAX_ARTIFACT_MEMBER_BYTES}`);
  assert(members.maxTotalBytes >= members.maxMemberBytes && members.maxTotalBytes <= MAX_ARTIFACT_MEMBER_BYTES * MAX_ARTIFACT_MEMBERS,
    `${where}.maxTotalBytes must be in maxMemberBytes..${MAX_ARTIFACT_MEMBER_BYTES * MAX_ARTIFACT_MEMBERS}`);
  const extensions = members.allowedExtensions ?? [];
  assert(extensions.every((ext) => /^\.[a-z0-9]+$/.test(ext)) && new Set(extensions).size === extensions.length,
    `${where}.allowedExtensions must be unique lower-case ".ext" entries`);
  assertRequiredMemberNames(where, def, members);
  // A maxBytes that cannot hold the manifest of the REQUIRED members makes
  // every write unsatisfiable — a load failure, never a runtime surprise. The
  // bound is exact: the canonical manifest of exactly the required rows at the
  // per-member ceiling (row byte counts render at their widest there).
  const widestRequired = (members.requiredNames ?? []).map((fileName) => ({ fileName, sha256: "0".repeat(64), bytes: members.maxMemberBytes }));
  const minimalManifestBytes = Buffer.byteLength(JSON.stringify({ members: widestRequired }), "utf8");
  assert(def.maxBytes >= minimalManifestBytes,
    `${where}: maxBytes ${def.maxBytes} cannot hold the manifest of the required members (needs >= ${minimalManifestBytes})`);
}

/** The requiredNames half of {@link assertMembersDef}: unique, acceptable, policy-conforming, exactNames-consistent. */
function assertRequiredMemberNames(where: string, def: ArtifactTypeDef, members: NonNullable<ArtifactTypeDef["members"]>): void {
  const required = members.requiredNames ?? [];
  // ALIAS-keyed uniqueness: `a.tex` + `A.tex` would demand two rows the
  // manifest contract refuses as one physical file — an unwritable profile.
  assert(new Set(required.map(memberAliasKey)).size === required.length && required.length <= members.maxCount,
    `${where}.requiredNames must be unique (case/unicode-insensitively) and no more than maxCount`);
  for (const name of required) {
    assert(isSafeFilenameComponent(name) && !isReservedMemberName(def, name),
      `${where}.requiredNames entry ${JSON.stringify(name)} is not a safe, unreserved member name`);
  }
  assert(memberNamePolicyViolations(members, required).length === 0 || required.length === 0,
    `${where}.requiredNames must themselves satisfy allowedExtensions`);
  assert(members.exactNames !== true || required.length > 0, `${where}.exactNames requires a non-empty requiredNames`);
}
