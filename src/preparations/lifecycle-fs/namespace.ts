/**
 * @file src/preparations/lifecycle-fs/namespace.ts
 * @description Opens and revalidates the one root-anchored filesystem
 * authority for preparation lifecycle state.
 *
 * The project root is canonicalized once. `.llmwiki` and both physical
 * lifecycle registries must be real directory children at their literal
 * canonical paths; a symlink is rejected even when it points elsewhere inside
 * the project. Read mode proves absence without creating state. Mutate mode
 * creates only a proved-absent owned directory, fsyncs its parent, and captures
 * the resulting identity.
 */

import { lstat, mkdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { fsyncDirectoryChain } from "../../utils/atomic-write-durability.js";
import { LLMWIKI_DIR } from "../../utils/constants.js";
import { lstatLeaf } from "../../utils/fs-presence.js";
import {
  PREPARATION_PRUNE_REGISTRY,
  PREPARATION_QUARANTINE_SEGMENT,
  preparationKeyFile,
} from "../paths.js";
import type {
  AbsentLifecycleDirectoryV1,
  BoundLifecycleDirectoryV1,
  BoundLifecycleRegistryV1,
  BoundLifecycleKeyLeafV1,
  PreparationLifecycleNamespaceMode,
  PreparationLifecycleNamespaceV1,
  PresentLifecycleKeyLeafV1,
  PresentLifecycleDirectoryV1,
} from "./types.js";

/** Process-local provenance for namespace objects minted by this module. */
const OPENED_NAMESPACES = new WeakSet<object>();

/** Test-only seam immediately before the final open-time identity recheck. */
interface PreparationLifecycleNamespaceOpenOptions {
  beforeFinalRevalidationForTest?: () => Promise<void>;
}

/** Typed fail-closed namespace capture or revalidation error. */
export class PreparationLifecycleNamespaceError extends Error {
  constructor(
    readonly code:
      | "root-unavailable"
      | "private-root-unavailable"
      | "registry-unavailable"
      | "key-unavailable"
      | "namespace-changed",
    message: string,
  ) {
    super(message);
    this.name = "PreparationLifecycleNamespaceError";
  }
}

/** Freeze one proved-absent exact child. */
function absentDirectory(lexicalPath: string): AbsentLifecycleDirectoryV1 {
  return Object.freeze({ status: "absent", lexicalPath });
}

/** Freeze one key-leaf identity without retaining its bytes. */
function presentKeyLeaf(
  lexicalPath: string,
  stats: Stats,
): PresentLifecycleKeyLeafV1 {
  return Object.freeze({
    status: "present",
    lexicalPath,
    kind: stats.isFile() && !stats.isSymbolicLink() ? "regular" : "other",
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mode: stats.mode,
    nlink: stats.nlink,
    uid: stats.uid,
  });
}

/** Freeze one captured real directory identity. */
function presentDirectory(
  lexicalPath: string,
  realPath: string,
  dev: number,
  ino: number,
): PresentLifecycleDirectoryV1 {
  return Object.freeze({ status: "present", lexicalPath, realPath, dev, ino });
}

/** Capture the supplied project-root alias and the canonical directory it names. */
async function captureRoot(root: string): Promise<PresentLifecycleDirectoryV1> {
  const lexicalPath = path.resolve(root);
  try {
    const realPath = await realpath(lexicalPath);
    const before = await lstat(realPath);
    const after = await lstat(realPath);
    if (!before.isDirectory() || before.isSymbolicLink() ||
        before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("project root is not a stable real directory");
    }
    return presentDirectory(lexicalPath, realPath, after.dev, after.ino);
  } catch {
    throw new PreparationLifecycleNamespaceError(
      "root-unavailable",
      "preparation lifecycle project root is unavailable",
    );
  }
}

/** Capture one literal child beneath a present canonical parent. */
async function captureChild(
  parent: PresentLifecycleDirectoryV1,
  segment: string,
  code: "private-root-unavailable" | "registry-unavailable",
): Promise<BoundLifecycleDirectoryV1> {
  const lexicalPath = path.join(parent.realPath, segment);
  const leaf = await lstatLeaf(lexicalPath);
  if (leaf.kind === "absent") return absentDirectory(lexicalPath);
  if (leaf.kind !== "present" || !leaf.stats.isDirectory() || leaf.stats.isSymbolicLink()) {
    throw new PreparationLifecycleNamespaceError(code, `${segment} is unavailable`);
  }
  return finishChildCapture(lexicalPath, leaf.stats.dev, leaf.stats.ino, code);
}

/** Finish a child capture without accepting a redirected path or identity swap. */
async function finishChildCapture(
  lexicalPath: string,
  dev: number,
  ino: number,
  code: "private-root-unavailable" | "registry-unavailable",
): Promise<PresentLifecycleDirectoryV1> {
  try {
    const realPath = await realpath(lexicalPath);
    const after = await lstat(lexicalPath);
    if (realPath !== lexicalPath || after.isSymbolicLink() || !after.isDirectory() ||
        after.dev !== dev || after.ino !== ino) {
      throw new Error("directory identity changed");
    }
    return presentDirectory(lexicalPath, realPath, after.dev, after.ino);
  } catch {
    throw new PreparationLifecycleNamespaceError(code, "lifecycle directory is redirected or changed");
  }
}

/** Durably create one proved-absent child, then bind the exact directory created. */
async function createChild(
  parent: PresentLifecycleDirectoryV1,
  segment: string,
  code: "private-root-unavailable" | "registry-unavailable",
): Promise<PresentLifecycleDirectoryV1> {
  const lexicalPath = path.join(parent.realPath, segment);
  try {
    await mkdir(lexicalPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new PreparationLifecycleNamespaceError(code, `${segment} could not be created`);
    }
  }
  await fsyncDirectoryChain(parent.realPath);
  const captured = await captureChild(parent, segment, code);
  if (captured.status !== "present") {
    throw new PreparationLifecycleNamespaceError(code, `${segment} remained absent after creation`);
  }
  return captured;
}

/** Capture or create one child according to the namespace mode. */
async function ownedChild(
  parent: PresentLifecycleDirectoryV1,
  segment: string,
  mode: PreparationLifecycleNamespaceMode,
  code: "private-root-unavailable" | "registry-unavailable",
): Promise<BoundLifecycleDirectoryV1> {
  const captured = await captureChild(parent, segment, code);
  return captured.status === "absent" && mode === "mutate"
    ? createChild(parent, segment, code)
    : captured;
}

/** Produce absent registry bindings below an absent private-root path. */
function absentRegistries(privateRoot: AbsentLifecycleDirectoryV1) {
  return {
    quarantineRegistry: absentDirectory(path.join(privateRoot.lexicalPath, PREPARATION_QUARANTINE_SEGMENT)),
    pruneRegistry: absentDirectory(path.join(privateRoot.lexicalPath, PREPARATION_PRUNE_REGISTRY)),
  };
}

/**
 * Bind the prune registry, degrading a READ-mode binding fault to unavailable
 * state instead of rejecting the capture.
 *
 * Mutate mode stays strictly fail-closed: a destructive operation may not stage
 * receipts into a registry whose identity it could not prove. Read mode carries
 * the fault as prune-specific unavailable storage, which every prune consumer
 * already treats as a refusal, so a prune-root fault no longer blocks the
 * quarantine-only decisions that never consulted prune in the first place.
 */
async function capturePruneRegistry(
  privateRoot: PresentLifecycleDirectoryV1,
  mode: PreparationLifecycleNamespaceMode,
): Promise<BoundLifecycleRegistryV1> {
  const capture = () => captureChild(privateRoot, PREPARATION_PRUNE_REGISTRY, "registry-unavailable");
  if (mode === "mutate") return capture();
  try {
    return await capture();
  } catch (error) {
    if (!(error instanceof PreparationLifecycleNamespaceError) || error.code !== "registry-unavailable") {
      throw error;
    }
    return Object.freeze({
      status: "unavailable" as const,
      lexicalPath: path.join(privateRoot.realPath, PREPARATION_PRUNE_REGISTRY),
      detail: error.message,
    });
  }
}

/** Bind both physical registries below one present private root. */
async function captureRegistries(
  privateRoot: PresentLifecycleDirectoryV1,
  mode: PreparationLifecycleNamespaceMode,
) {
  const quarantine = await captureChild(
    privateRoot, PREPARATION_QUARANTINE_SEGMENT, "registry-unavailable",
  );
  const prune = await capturePruneRegistry(privateRoot, mode);
  if (mode === "read") {
    return { quarantineRegistry: quarantine, pruneRegistry: prune };
  }
  return {
    quarantineRegistry: quarantine.status === "present"
      ? quarantine
      : await createChild(privateRoot, PREPARATION_QUARANTINE_SEGMENT, "registry-unavailable"),
    pruneRegistry: prune.status === "present"
      ? prune
      : await createChild(privateRoot, PREPARATION_PRUNE_REGISTRY, "registry-unavailable"),
  };
}

/** Capture the exact key leaf derived beneath the bound private root. */
async function capturePreparationKey(
  root: PresentLifecycleDirectoryV1,
  privateRoot: BoundLifecycleDirectoryV1,
): Promise<BoundLifecycleKeyLeafV1> {
  const lexicalPath = preparationKeyFile(root.realPath);
  if (privateRoot.status === "absent") return absentDirectory(lexicalPath);
  const before = await lstatLeaf(lexicalPath);
  if (before.kind === "absent") return absentDirectory(lexicalPath);
  if (before.kind === "unavailable") {
    throw new PreparationLifecycleNamespaceError("key-unavailable", "preparation key is unavailable");
  }
  const after = await lstatLeaf(lexicalPath);
  if (after.kind !== "present" || !sameKeyStats(before.stats, after.stats)) {
    throw new PreparationLifecycleNamespaceError("key-unavailable", "preparation key changed during capture");
  }
  return presentKeyLeaf(lexicalPath, after.stats);
}

/** Compare every key-leaf fact that the namespace retains. */
function sameKeyStats(
  before: Stats,
  after: Stats,
): boolean {
  return before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mode === after.mode &&
    before.nlink === after.nlink && before.uid === after.uid &&
    before.isFile() === after.isFile() &&
    before.isSymbolicLink() === after.isSymbolicLink();
}

/** Canonical internal digest of one captured namespace authority. */
function namespaceDigest(input: Omit<PreparationLifecycleNamespaceV1, "digest">): string {
  const binding = (value: BoundLifecycleRegistryV1) => value.status === "present"
    ? {
      status: value.status,
      lexicalPath: value.lexicalPath,
      realPath: value.realPath,
      dev: value.dev,
      ino: value.ino,
    }
    : { status: value.status, lexicalPath: value.lexicalPath };
  return canonicalDigest({
    domain: "llmwiki.preparation-lifecycle.namespace.v1",
    root: {
      status: input.root.status,
      realPath: input.root.realPath,
      dev: input.root.dev,
      ino: input.root.ino,
    },
    privateRoot: binding(input.privateRoot),
    quarantineRegistry: binding(input.quarantineRegistry),
    pruneRegistry: binding(input.pruneRegistry),
  });
}

/** Open the immutable preparation lifecycle namespace in read or mutate mode. */
export async function openPreparationLifecycleNamespace(
  root: string,
  mode: PreparationLifecycleNamespaceMode,
  options: PreparationLifecycleNamespaceOpenOptions = {},
): Promise<PreparationLifecycleNamespaceV1> {
  const rootBinding = await captureRoot(root);
  const privateRoot = await ownedChild(
    rootBinding, LLMWIKI_DIR, mode, "private-root-unavailable",
  );
  const registries = privateRoot.status === "present"
    ? await captureRegistries(privateRoot, mode)
    : absentRegistries(privateRoot);
  const preparationKey = await capturePreparationKey(rootBinding, privateRoot);
  const captured = {
    mode,
    root: rootBinding,
    privateRoot,
    ...registries,
    preparationKey,
  };
  const namespace = { ...captured, digest: namespaceDigest(captured) };
  Object.freeze(namespace);
  OPENED_NAMESPACES.add(namespace);
  await options.beforeFinalRevalidationForTest?.();
  await assertPreparationLifecycleNamespaceCurrent(namespace);
  return namespace;
}

/** True when a key leaf is still absent or retains the same exact identity. */
function sameKeyBinding(
  expected: BoundLifecycleKeyLeafV1,
  actual: BoundLifecycleKeyLeafV1,
): boolean {
  if (expected.status !== actual.status) return false;
  if (expected.lexicalPath !== actual.lexicalPath) return false;
  if (expected.status === "absent") return true;
  if (actual.status !== "present") return false;
  return keyLeafFingerprint(expected) === keyLeafFingerprint(actual);
}

/** Stable comparison value for the retained key-leaf identity facts. */
function keyLeafFingerprint(value: PresentLifecycleKeyLeafV1): string {
  return [value.kind, value.dev, value.ino, value.size, value.mode, value.nlink, value.uid].join(":");
}

/** True when two present/absent/unbound bindings are still the same authority. */
function sameBinding(
  expected: BoundLifecycleRegistryV1,
  actual: BoundLifecycleRegistryV1,
): boolean {
  if (expected.status !== actual.status || expected.lexicalPath !== actual.lexicalPath) return false;
  // Every transition that matters is already refused by the status compare above:
  // unavailable→present (a registry repaired mid-read) and unavailable→absent both
  // change status. Drift WITHIN unavailable — one decoy swapped for another — is
  // deliberately NOT detected, because every consumer treats the state as a refusal,
  // so the two shapes are behaviourally identical.
  //
  // This previously also compared `detail`. That term was uncovered by any test and
  // arbitrary in effect: `detail` is one of two constants, so it caught a swap that
  // happened to change the failure MESSAGE and missed every swap that did not. It
  // also disagreed with `namespaceDigest`, which omits `detail`. Removed so the two
  // functions state one identity rule rather than two.
  if (expected.status === "unavailable") return true;
  return expected.status === "absent" ||
    (actual.status === "present" &&
      expected.realPath === actual.realPath &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino);
}

/** Refuse a structurally forged namespace that was not opened by this authority. */
export function assertPreparationLifecycleNamespaceBrand(
  namespace: PreparationLifecycleNamespaceV1,
): void {
  if (!OPENED_NAMESPACES.has(namespace)) {
    throw new PreparationLifecycleNamespaceError(
      "namespace-changed",
      "namespace was not opened by the lifecycle authority",
    );
  }
}

/** True when a supplied root resolves to one previously captured root identity. */
export async function preparationLifecycleRootMatchesBinding(
  root: string,
  expected: PresentLifecycleDirectoryV1,
): Promise<boolean> {
  try {
    const actual = await captureRoot(root);
    return actual.realPath === expected.realPath &&
      actual.dev === expected.dev &&
      actual.ino === expected.ino;
  } catch {
    return false;
  }
}

/** Re-open the namespace and require every captured identity to remain current. */
export async function assertPreparationLifecycleNamespaceCurrent(
  namespace: PreparationLifecycleNamespaceV1,
): Promise<void> {
  assertPreparationLifecycleNamespaceBrand(namespace);
  try {
    const root = await captureRoot(namespace.root.lexicalPath);
    if (!sameBinding(namespace.root, root)) throw new Error("root changed");
    const privateRoot = await captureChild(root, LLMWIKI_DIR, "private-root-unavailable");
    if (!sameBinding(namespace.privateRoot, privateRoot)) throw new Error("private root changed");
    if (privateRoot.status === "absent") return;
    const registries = await captureRegistries(privateRoot, "read");
    if (!sameBinding(namespace.quarantineRegistry, registries.quarantineRegistry) ||
        !sameBinding(namespace.pruneRegistry, registries.pruneRegistry)) {
      throw new Error("registry changed");
    }
    const preparationKey = await capturePreparationKey(root, privateRoot);
    if (!sameKeyBinding(namespace.preparationKey, preparationKey)) {
      throw new Error("preparation key changed");
    }
  } catch {
    throw new PreparationLifecycleNamespaceError(
      "namespace-changed",
      "preparation lifecycle namespace changed after capture",
    );
  }
}

export type {
  PreparationLifecycleNamespaceMode,
  PreparationLifecycleNamespaceV1,
} from "./types.js";

/**
 * One stable identity for a project root, for callers that must compare roots
 * without opening the namespace.
 *
 * Lives here because this module already owns raw filesystem access; the driver
 * needs the identity for its re-entrancy guard and must not grow a raw `node:fs`
 * import to get it. `realpath` collapses symlinks and aliases; a root that does
 * not resolve — it may not exist yet — falls back to lexical resolution, which
 * still collapses trailing separators and relative segments.
 */
export async function canonicalPreparationRootIdentity(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
}
