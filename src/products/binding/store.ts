/**
 * @file src/products/binding/store.ts
 * @description Atomic, durable read/write of `.llmwiki/active-product.json`, the
 * single active-product authority pointer (design sections 8.2, 8.3). The read is
 * confined and no-follow through the shared hardened leaf reader, so a symlinked
 * `.llmwiki` dir OR a symlinked/oversize/non-regular binding leaf fails closed as
 * `malformed` rather than reading out-of-tree bytes; a genuinely absent binding is
 * `absent` (the legacy-mode signal). The write goes through the shared durable
 * atomic replace (write-temp -> fsync -> atomic rename -> parent fsync -> verify),
 * the same primitive the run, catalog, and relation stores use, so a fault at any
 * point leaves ONLY the complete-old or complete-new binding on disk, never a
 * partial one. `profileJsonPresent` is the read used to detect the design section
 * 8.2 product-authority conflict.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { atomicWrite } from "../../utils/atomic-write.js";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import { resolveExistingConfinedPrivateDir } from "../../utils/private-dir.js";
import { legacyPrivateAliasHasNoEntries } from "../../utils/legacy-private-layout.js";
import { LLMWIKI_DIR, PROFILE_FILE } from "../../utils/constants.js";
import { parseActiveProductBinding } from "./parse.js";
import { MAX_ACTIVE_PRODUCT_BINDING_BYTES } from "./types.js";
import type { ActiveProductBindingV1 } from "./types.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const ACTIVE_PRODUCT_FILENAME = "active-product.json";
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
 * Read and classify the active-product binding through the hardened confined,
 * no-follow, single-link reader. A present leaf is strictly UTF-8 decoded and
 * shape-parsed; any parse refusal is `malformed`, never a silent legacy fallback.
 */
export async function readActiveProductBinding(root: string): Promise<ActiveBindingRead> {
  const read = await readConfinedLeafBuffer(
    root, activeProductBindingPath(root), privateDir(root), MAX_ACTIVE_PRODUCT_BINDING_BYTES,
    { requireSingleLink: true });
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable" && await legacyPrivateAliasHasNoEntries(root, [ACTIVE_PRODUCT_FILENAME]).catch(() => false)) {
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
export async function profileJsonPresent(root: string): Promise<boolean> {
  const dir = await resolveExistingConfinedPrivateDir(root).catch(() => null);
  if (dir === null) return false;
  const stat = await lstat(path.join(dir, path.basename(PROFILE_FILE))).catch(() => null);
  return stat !== null;
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

/**
 * Durably write the active-product binding through the shared atomic replace. The
 * caller MUST hold the project lock. A fault at any point leaves only the
 * complete-old binding (before the rename commits) or the complete-new binding
 * (after it), never a partial authority.
 */
export async function writeActiveProductBinding(
  root: string, binding: ActiveProductBindingV1, faults: ActiveBindingWriteFaultsV1 = {},
): Promise<void> {
  await faults.beforeWrite?.();
  await atomicWrite(activeProductBindingPath(root), canonicalBytes(binding), {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: OWNER_PRIVATE_FILE,
    ...(faults.afterParentCheck ? { afterParentCheckForTest: faults.afterParentCheck } : {}),
    ...(faults.beforeParentSync ? { beforeDirectorySyncForTest: faults.beforeParentSync } : {}),
  });
  await faults.afterWrite?.();
}
