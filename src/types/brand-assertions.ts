/**
 * @file src/types/brand-assertions.ts
 * @description Compile-time proof that a branded id has not been widened.
 *
 * Widening a branded type is the cheapest way to make type errors disappear
 * without touching the code that caused them: measured, changing `MutationId`
 * from a template literal to `string` removed 11 test type errors while every
 * other gate stayed green, using no forbidden syntax at all. Nothing else in the
 * toolchain notices — there is no lint rule for "this type got weaker".
 *
 * These live in `src/` so `npx tsc --noEmit` checks them. Stated precisely,
 * because the imprecise version was wrong: `npm run build` exits ZERO with a
 * widened brand — tsup emits declarations for one entry and does not type-check
 * the tree. The `tsc` step is the one that catches this, and it only runs in CI
 * because the same change that added these added that step.
 *
 * NOT covered here: `Sha256Digest`. It is protected by a PRE-EXISTING assertion,
 * `_RawDigestRequiresParsing` in `capability-providers/types.ts`, which is the
 * single largest lever in the repository — dropping that brand removes 74 test
 * errors, 20% of the baseline. It is named here so a later "unused type alias"
 * cleanup cannot quietly remove the strongest protection in the stack.
 *
 * Each assertion pins ONE negative sample, not the grammar: widening
 * `MutationId` to `` `${string}_${string}` `` would still reject the probe and
 * pass. That is a known limit, not an oversight.
 *
 * This is the shared home for the pattern. Four separate copies of the same two
 * lines already existed; a fifth would have been the DRY violation the repository
 * rules forbid, in a file added to enforce rigour.
 */

/** True only when `Source` is assignable to `Target`. */
export type BrandAssignable<Source, Target> = [Source] extends [Target] ? true : false;

/** Compiles only when `Value` is `false`; the assertion mechanism itself. */
export type BrandAssertFalse<Value extends false> = Value;

/**
 * The probe value. A plain string that no branded id should accept.
 *
 * Deliberately not wrapped in a one-parameter `AssertBranded<T>` helper: with an
 * unconstrained parameter TypeScript resolves the comparison to `boolean` rather
 * than `false`, so the wrapper fails to compile for every brand — including
 * sound ones. The assertion has to be applied at the use site.
 */
export type BrandProbe = "plain-string-probe";

/**
 * The helper's own mutation test, and the reason it is here rather than in a test
 * file: it must fail the SAME gate the assertions it powers do.
 *
 * Consolidating seventeen tripwires onto one helper is right, and it created a
 * single point of failure with no control on it — relaxing this constraint from
 * `false` to `boolean` disarmed every brand at once while `tsc --noEmit` stayed
 * green. By the repository's own rule, making the change a control claims to
 * catch must turn something red, and nothing did.
 *
 * This is self-mutation-testing: relax the constraint and the directive below
 * becomes unused, which is itself an error (TS2578).
 */
// @ts-expect-error `BrandAssertFalse` must reject `true`; if this stops erroring,
// the constraint has been widened and every brand tripwire is disarmed.
type _HelperRejectsTrue = BrandAssertFalse<true>;
