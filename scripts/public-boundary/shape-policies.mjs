/**
 * @file scripts/public-boundary/shape-policies.mjs
 * @description Validation of the shape check's named LIBRARY-OUTPUT POLICIES
 * (`surface.shapePolicies.libraryOutputTypes` in the boundary manifest).
 *
 * A policy lets one type that only the library constructs gain exactly the
 * listed members without the reverse probe failing on it. It is applied only
 * when every part of it is proven against the two trees; otherwise it is
 * REJECTED, reported as a finding, and the type is probed like any other.
 *
 * A policy is `{ facade, name, declaration: { module, name }, reason,
 * allowedAdditions }`, and it is valid only when:
 * - its shape is exactly that, with non-empty strings and a non-empty list of
 *   distinct identifiers;
 * - no other policy names the same facade and type (duplicates reject ALL of
 *   them, never "last one wins");
 * - the facade is one the check compares, and the baseline facade exports the
 *   name as a non-generic type;
 * - in the candidate facade, the name resolves to exactly ONE declaration, in
 *   the stated module, with the stated declared name (a merged or re-declared
 *   type is ambiguous; a same-named type elsewhere is not this one);
 * - every allowed addition is a member of the candidate type and NOT a member
 *   of the baseline type.
 * A policy scopes to its own facade only: the same name in another facade is
 * never exempted by it.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)("typescript");

/** A member name an allowance may list. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** Whether `value` is an object with exactly the comma-joined sorted `keys`. */
function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
}

/** Whether `value` is a non-empty string. */
const isText = (value) => typeof value === "string" && value.length > 0;

/** Why a policy's identifying fields (its keys, facade, name, reason and declaration) are invalid, or null. */
function identityProblem(policy) {
  if (!hasExactKeys(policy, "allowedAdditions,declaration,facade,name,reason")) return "a policy must have exactly facade, name, declaration, reason and allowedAdditions";
  if (![policy.facade, policy.name, policy.reason].every(isText)) return "facade, name and reason must be non-empty strings";
  const declaration = policy.declaration;
  return hasExactKeys(declaration, "module,name") && isText(declaration.module) && isText(declaration.name) ? null : "declaration must be exactly { module, name }";
}

/** Why an allowance list is not a non-empty list of distinct identifiers, or null. */
function allowanceListProblem(allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return "allowedAdditions must be a non-empty list";
  if (!allowed.every((member) => typeof member === "string" && IDENTIFIER.test(member))) return "every allowed addition must be an identifier";
  return new Set(allowed).size === allowed.length ? null : "allowedAdditions lists a member twice";
}

/** Why a policy's own shape is invalid, or null when it is well formed (identity first, then its allowances). */
function shapeProblem(policy) {
  return identityProblem(policy) ?? allowanceListProblem(policy.allowedAdditions);
}

/** The exported symbol `name` of a facade source file, aliases resolved, or undefined. */
function exportedTarget(checker, source, name) {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const symbol = moduleSymbol === undefined ? undefined : checker.getExportsOfModule(moduleSymbol).find((entry) => entry.name === name);
  if (symbol === undefined) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** The member names of a type symbol's declared type. */
function memberNames(checker, target) {
  return new Set(checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target)).map((member) => member.name));
}

/** Why the candidate declaration does not match the policy's stated origin, or null. */
function originProblem(target, policy, root) {
  const declarations = target?.declarations ?? [];
  if (declarations.length !== 1) return `the candidate type has ${declarations.length} declarations; exactly one is required`;
  const [declaration] = declarations;
  // Both sides as real paths: the compiler may report a file through resolved links (for example /var to /private/var).
  const module = path.relative(realpathSync(root), realpathSync(declaration.getSourceFile().fileName)).split(path.sep).join("/");
  const declared = declaration.name?.getText();
  if (module !== policy.declaration.module || declared !== policy.declaration.name) {
    return `the candidate type is declared as ${declared ?? "(unnamed)"} in ${module}, not ${policy.declaration.name} in ${policy.declaration.module}`;
  }
  return null;
}

/** Why the allowances are not genuine additions of the candidate type, or null. */
function allowanceProblem(checker, baselineTarget, candidateTarget, policy) {
  const baseline = memberNames(checker.baseline, baselineTarget);
  const candidate = memberNames(checker.candidate, candidateTarget);
  const inBaseline = policy.allowedAdditions.filter((member) => baseline.has(member));
  if (inBaseline.length > 0) return `allowedAdditions names baseline member(s) ${inBaseline.join(", ")}`;
  const absent = policy.allowedAdditions.filter((member) => !candidate.has(member));
  return absent.length === 0 ? null : `allowedAdditions names member(s) the candidate type does not have: ${absent.join(", ")}`;
}

/** Why one well-formed, unique policy cannot apply to this facade pair, or null when it can. */
function bindingProblem(context, policy) {
  const { checker, sources, classify, root } = context;
  const baselineTarget = exportedTarget(checker.baseline, sources.baseline, policy.name);
  if (baselineTarget === undefined) return "the baseline facade does not export this name";
  const kind = classify(baselineTarget);
  if (!kind.isType || kind.isGeneric) return "the baseline export is not a non-generic type";
  const candidateTarget = exportedTarget(checker.candidate, sources.candidate, policy.name);
  if (candidateTarget === undefined) return "the candidate facade does not export this name";
  return originProblem(candidateTarget, policy, root) ?? allowanceProblem(checker, baselineTarget, candidateTarget, policy);
}

/** The policy's identity within the manifest. */
const keyOf = (policy) => `${policy?.facade}:${policy?.name}`;

/**
 * Policies rejected before any facade is compared: malformed, duplicated, or
 * naming a facade the check does not compare. Returns the remaining valid
 * policies and the rejections.
 */
export function screenPolicies(policies, facadeKeys) {
  const counts = new Map();
  for (const policy of policies) counts.set(keyOf(policy), (counts.get(keyOf(policy)) ?? 0) + 1);
  const valid = [];
  const rejected = [];
  for (const policy of policies) {
    const problem = screenProblem(policy, counts, facadeKeys);
    if (problem === null) valid.push(policy); else rejected.push({ policy: keyOf(policy), reason: problem });
  }
  return { valid, rejected };
}

/** Why one policy is rejected before any facade is compared (its shape, then a duplicate, then its facade), or null. */
function screenProblem(policy, counts, facadeKeys) {
  const shape = shapeProblem(policy);
  if (shape !== null) return shape;
  if (counts.get(keyOf(policy)) > 1) return "another policy names the same facade and type";
  return facadeKeys.includes(policy.facade) ? null : `facade ${policy.facade} is not one the shape check compares`;
}

/**
 * The policies of one facade pair that bind: each proven against the baseline
 * and candidate declarations, or rejected with the reason.
 *
 * @param context - `{ facade, checker: { baseline, candidate }, sources: { baseline, candidate }, classify, root }`.
 */
export function bindPolicies(context, policies) {
  const applied = new Map();
  const rejected = [];
  for (const policy of policies.filter((entry) => entry.facade === context.facade)) {
    const problem = bindingProblem(context, policy);
    if (problem === null) applied.set(policy.name, policy); else rejected.push({ policy: keyOf(policy), reason: problem });
  }
  return { applied, rejected };
}
