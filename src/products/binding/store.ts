/**
 * @file src/products/binding/store.ts
 * @description Atomic, durable read/write of `.llmwiki/active-product.json`, the
 * single active-product authority pointer (design sections 8.2, 8.3). The read is
 * confined and no-follow through the shared hardened leaf reader (reached by its
 * local-disk storage wrapper, which passes it through unchanged), so a symlinked
 * `.llmwiki` dir OR a symlinked/oversize/non-regular binding leaf fails closed as
 * `malformed` rather than reading out-of-tree bytes; a genuinely absent binding is
 * `absent` (the legacy-mode signal). The write goes through the shared durable
 * atomic replace (write-temp -> fsync -> atomic rename -> parent fsync -> verify),
 * the same primitive the run, catalog, and relation stores use, so a fault at any
 * point leaves ONLY the complete-old or complete-new binding on disk, never a
 * partial one. `profileJsonPresent` is the read used to detect the design section
 * 8.2 product-authority conflict.
 *
 * READ SIDE: {@link readActiveProductBinding} and {@link profileJsonPresent} each
 * run one body over local-disk {@link ActiveBindingReads}. What an unreadable
 * leaf, an empty alias, a failed directory resolution or a failed look MEANS is
 * decided in those bodies, catch-alls included; the reads only look.
 *
 * WRITE SIDE: {@link writeActiveProductBindingTo} keeps the canonical bytes and
 * the fault-seam order (before, the two straddling the rename, after) over
 * {@link ActiveBindingWrite}; {@link writeActiveProductBinding} passes
 * {@link diskActiveBindingWrite}, the incumbent durable, exact-parent, 0600
 * atomic replace of `.llmwiki/active-product.json`.
 */

import path from "node:path";
import { TextDecoder } from "node:util";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { replaceLeafAtomicWith } from "../../storage/disk-durable-leaves.js";
import { readConfinedLeafBytes } from "../../storage/disk-guarded-leaves.js";
import { locationKindNoFollow } from "../../storage/disk-local-reads.js";
import type { LocalEntryKind } from "../../storage/legacy-local-reads.js";
import type { CappedLeafReadBuffer } from "../../utils/confined-read.js";
import { resolveExistingConfinedPrivateDir } from "../../utils/private-dir.js";
import { legacyPrivateAliasHasNoEntries } from "../../utils/legacy-private-layout.js";
import { LLMWIKI_DIR, PROFILE_FILE } from "../../utils/constants.js";
import { parseActiveProductBinding } from "./parse.js";
import { MAX_ACTIVE_PRODUCT_BINDING_BYTES } from "./types.js";
import type { ActiveProductBindingV1 } from "./types.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
/** The binding leaf under `.llmwiki/`. Exported so every reader names the same file. */
export const ACTIVE_PRODUCT_FILENAME = "active-product.json";
const OWNER_PRIVATE_FILE = 0o600;

/**
 * The classified outcome of reading `active-product.json`. `absent` is the clean
 * legacy-mode signal; `malformed` is present-but-unsafe (symlinked, oversize,
 * non-regular, or unparseable) and NEVER falls back to legacy; `present` carries
 * the fully shape-validated binding.
 */
export type ActiveBindingRead =
  | { kind: "absent" }
  | { kind: "malformed"; detail: string }
  | { kind: "present"; binding: ActiveProductBindingV1 };

/** The lexical `.llmwiki` directory a binding leaf is confined under. */
function privateDir(root: string): string {
  return path.join(root, LLMWIKI_DIR);
}

/** The lexical `.llmwiki/active-product.json` authority path. */
export function activeProductBindingPath(root: string): string {
  return path.join(privateDir(root), ACTIVE_PRODUCT_FILENAME);
}

/**
 * The looks the binding reader and the profile-presence check take at the
 * project's private directory. OWNED BY THE BINDING STORE: a narrow seam with one
 * disk implementation; not `ProjectStore`, not a hosted or access-control
 * contract. It carries NO meaning: every catch-all and every "this counts as
 * absent" stays with the caller.
 */
export interface ActiveBindingReads {
  /** The binding leaf, confined to the private directory, refusing a link and a hard-linked file: `ok`, `absent` or `unavailable`. */
  readBindingLeaf(maxBytes: number): Promise<CappedLeafReadBuffer>;
  /**
   * STABLE CONFINED-ALIAS CHECK, more than identity: the private directory is a
   * link inside the project, its target is a real directory holding NONE of
   * `names`, and both are the same objects before and after the look. MAY REJECT.
   */
  privateAliasHasNoEntries(names: readonly string[]): Promise<boolean>;
  /** The existing private directory, resolved WITHOUT creating it, or `null` when there is none. REJECTS on a confinement fault and on any other failure. */
  resolvePrivateDir(): Promise<string | null>;
  /** What one entry of a resolved private directory IS, without following a link. REJECTS raw, for a missing entry too. */
  privateEntryKind(dir: string, name: string): Promise<LocalEntryKind>;
}

/** LOCAL DISK. The private-directory looks for the project at `root`. Building it does no I/O. In no package index. */
export function diskActiveBindingReads(root: string): ActiveBindingReads {
  return {
    readBindingLeaf: (maxBytes) =>
      readConfinedLeafBytes(root, activeProductBindingPath(root), privateDir(root), maxBytes, { requireSingleLink: true }),
    privateAliasHasNoEntries: (names) => legacyPrivateAliasHasNoEntries(root, names),
    resolvePrivateDir: () => resolveExistingConfinedPrivateDir(root),
    privateEntryKind: (dir, name) => locationKindNoFollow(path.join(dir, name)),
  };
}

/**
 * Read and classify the active-product binding through the hardened confined,
 * no-follow, single-link reader. A present leaf is strictly UTF-8 decoded and
 * shape-parsed; any parse refusal is `malformed`, never a silent legacy fallback.
 */
export function readActiveProductBinding(root: string): Promise<ActiveBindingRead> {
  return readActiveProductBindingFrom(diskActiveBindingReads(root));
}

/**
 * {@link readActiveProductBinding} over {@link ActiveBindingReads}: THE ONE BODY.
 * The alias check is asked ONLY after an `unavailable` read, with the binding's
 * own name, and a check that REJECTS counts as "no": the result is then
 * `malformed`, never `absent`.
 */
export async function readActiveProductBindingFrom(reads: ActiveBindingReads): Promise<ActiveBindingRead> {
  const read = await reads.readBindingLeaf(MAX_ACTIVE_PRODUCT_BINDING_BYTES);
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable" && await reads.privateAliasHasNoEntries([ACTIVE_PRODUCT_FILENAME]).catch(() => false)) {
    return { kind: "absent" };
  }
  if (read.kind !== "ok") return { kind: "malformed", detail: "unsafe-leaf" };
  try {
    return { kind: "present", binding: parseActiveProductBinding(STRICT_UTF8.decode(read.body)) };
  } catch (error) {
    return { kind: "malformed", detail: error instanceof Error ? error.message : "unparseable" };
  }
}

/**
 * Whether a legacy `.llmwiki/profile.json` is present (design section 8.2). ANY
 * on-disk entry counts, including a symlink, so its mere presence beside a binding
 * is fail-closed as a conflict. An absent or unreadable private dir is `false`.
 */
export function profileJsonPresent(root: string): Promise<boolean> {
  return profileJsonPresentFrom(diskActiveBindingReads(root));
}

/**
 * {@link profileJsonPresent} over {@link ActiveBindingReads}: THE ONE BODY. BOTH
 * catch-alls are here: a private directory that cannot be resolved, and a look
 * that fails, each mean "not present". Any kind of entry counts, a link included.
 */
export async function profileJsonPresentFrom(reads: ActiveBindingReads): Promise<boolean> {
  const dir = await reads.resolvePrivateDir().catch(() => null);
  if (dir === null) return false;
  const kind = await reads.privateEntryKind(dir, path.basename(PROFILE_FILE)).catch(() => null);
  return kind !== null;
}

/**
 * Optional crash-fault seams for the durable binding write, used ONLY by the
 * activation-fault test to prove the complete-old-or-complete-new invariant at
 * every stage. `beforeWrite` fires before any temp exists; `afterParentCheck` and
 * `beforeParentSync` are the {@link atomicWrite} seams straddling the atomic
 * rename; `afterWrite` fires once the write has fully settled.
 */
export interface ActiveBindingWriteFaultsV1 {
  beforeWrite?: () => Promise<void>;
  afterParentCheck?: () => Promise<void>;
  beforeParentSync?: (dir: string) => Promise<void>;
  afterWrite?: () => Promise<void>;
}

/** The binding leaf's one durable replace; the two test seams straddle its rename. */
export interface ActiveBindingWrite {
  replaceBinding(bytes: Buffer, seams: Pick<ActiveBindingWriteFaultsV1, "afterParentCheck" | "beforeParentSync">): Promise<void>;
}

/** LOCAL DISK: the incumbent durable, exact-parent, owner-private atomic replace for one root. In no package index. */
function diskActiveBindingWrite(root: string): ActiveBindingWrite {
  return {
    replaceBinding: (bytes, seams) => replaceLeafAtomicWith(activeProductBindingPath(root), bytes, {
      confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: OWNER_PRIVATE_FILE,
      ...(seams.afterParentCheck ? { afterParentCheckForTest: seams.afterParentCheck } : {}),
      ...(seams.beforeParentSync ? { beforeDirectorySyncForTest: seams.beforeParentSync } : {}),
    }),
  };
}

/**
 * Durably write the active-product binding through the shared atomic replace. The
 * caller MUST hold the project lock. A fault at any point leaves only the
 * complete-old binding (before the rename commits) or the complete-new binding
 * (after it), never a partial authority.
 */
export async function writeActiveProductBinding(
  root: string, binding: ActiveProductBindingV1, faults: ActiveBindingWriteFaultsV1 = {},
): Promise<void> {
  return writeActiveProductBindingTo(diskActiveBindingWrite(root), binding, faults);
}

/** {@link writeActiveProductBinding} over {@link ActiveBindingWrite}: THE ONE BODY. */
export async function writeActiveProductBindingTo(
  write: ActiveBindingWrite, binding: ActiveProductBindingV1, faults: ActiveBindingWriteFaultsV1 = {},
): Promise<void> {
  await faults.beforeWrite?.();
  await write.replaceBinding(canonicalBytes(binding), { afterParentCheck: faults.afterParentCheck, beforeParentSync: faults.beforeParentSync });
  await faults.afterWrite?.();
}
