/**
 * Read-only domain observations for external coordinators. Profile identity uses
 * the compiler's current loader; byte reads reuse its bounded, handle-bound
 * no-follow implementation after validating caller-supplied path selectors.
 * These observations neither lock future mutations nor confer write authority.
 */
import path from "node:path";
import { isInsideDir, safeRealpath } from "../utils/path-confine.js";
import { openConfinedLeaf, readConfirmedBufferOrElse, resolveExpectedReal } from "../utils/confined-read.js";

/** Observe the active profile digest, including the built-in default, without writing. */
export { activeProfileDigest } from "../profile/load.js";

/** Byte-exact read outcome; unavailable is never evidence that a target is absent. */
export type ConfinedCappedRead =
  | { kind: "absent" } | { kind: "unavailable" }
  | { kind: "oversize"; actualBytes: number } | { kind: "ok"; body: Buffer };

/**
 * Read a direct leaf of an existing canonical directory under root. Refuse
 * symlinked parents/leaves and invalid selectors; distinguish absent leaves
 * from unavailable parents. A valid cap is a nonnegative safe integer.
 * The bytes come from one confined handle with at most cap + 1 bytes read.
 */
export async function readConfinedCappedBuffer(
  root: string, leaf: string, expectedDir: string, maxBytes: number,
): Promise<ConfinedCappedRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) return { kind: "unavailable" };
  const base = path.resolve(root), parent = path.resolve(expectedDir), target = path.resolve(leaf);
  if (!isInsideDir(parent, base) || path.dirname(target) !== parent) return { kind: "unavailable" };
  const canonical = await resolveExpectedReal(base, parent);
  if (canonical === null || await safeRealpath(parent) !== canonical) return { kind: "unavailable" };
  const opened = await openConfinedLeaf(base, target, parent);
  if (opened.kind === "absent" && await safeRealpath(parent) !== canonical) return { kind: "unavailable" };
  if (opened.kind !== "confirmed") return opened;
  return readConfirmedBufferOrElse(opened, maxBytes, actualBytes => ({ kind: "oversize" as const, actualBytes }));
}
