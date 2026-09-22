/**
 * @file src/preparations/lifecycle-fs/key-observation.ts
 * @description Captures the preparation key from the exact leaf bound into the
 * lifecycle namespace. Key bytes remain internal and are copied before use.
 */

import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { openConfinedLeaf } from "../../utils/confined-read.js";
import { readOpenedPreparationKey } from "../key-epoch.js";
import { preparationKeyEpochId } from "../run-integrity.js";
import type { PreparationLifecycleNamespaceV1 } from "./types.js";
import { PreparationLifecycleNamespaceError } from "./namespace.js";

/** Private key observation used only within one scanner invocation. */
export type CapturedLifecycleKey =
  | { readonly status: "absent" }
  | { readonly status: "unavailable" }
  | { readonly status: "ok"; readonly key: Buffer; readonly keyEpochId: string };

/** Whether the opened key retains the metadata captured by the namespace. */
function openedKeyMatches(
  namespace: PreparationLifecycleNamespaceV1,
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
): boolean {
  const expected = namespace.preparationKey;
  if (expected.status !== "present" || expected.kind !== "regular") return false;
  const actualIdentity = [
    opened.dev, opened.ino, opened.size, opened.mode, opened.nlink, opened.uid,
  ].join(":");
  const expectedIdentity = [
    expected.dev, expected.ino, expected.size, expected.mode, expected.nlink, expected.uid,
  ].join(":");
  return actualIdentity === expectedIdentity && healthyKeyMetadata(opened.mode, opened.uid);
}

/** Enforce mode 0600 and current ownership on hosts that expose POSIX identity. */
function healthyKeyMetadata(mode: number, uid: number): boolean {
  const modeIsPrivate = process.platform === "win32" || (mode & 0o777) === 0o600;
  const ownerIsCurrent = typeof process.getuid !== "function" || uid === process.getuid();
  return modeIsPrivate && ownerIsCurrent;
}

/** Capture and decode the bound key once, never accepting a caller-provided key. */
export async function captureLifecycleKey(
  namespace: PreparationLifecycleNamespaceV1,
): Promise<CapturedLifecycleKey> {
  if (namespace.preparationKey.status === "absent") return { status: "absent" };
  const file = namespace.preparationKey.lexicalPath;
  const opened = await openConfinedLeaf(
    namespace.root.realPath,
    file,
    path.dirname(file),
    { requireSingleLink: true },
  );
  if (opened.kind !== "confirmed") return { status: "unavailable" };
  return captureOpenedKey(namespace, opened);
}

/** Validate, read, copy, and identify one already-opened bound key leaf. */
async function captureOpenedKey(
  namespace: PreparationLifecycleNamespaceV1,
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
): Promise<CapturedLifecycleKey> {
  if (!openedKeyMatches(namespace, opened)) {
    await opened.handle.close().catch(() => {});
    return { status: "unavailable" };
  }
  const decoded = await readOpenedPreparationKey(opened);
  if (decoded === null) return { status: "unavailable" };
  const key = Buffer.from(decoded);
  return { status: "ok", key, keyEpochId: preparationKeyEpochId(key) };
}

/** Whether two internal observations represent the same exact key authority. */
function sameCapturedKey(
  first: CapturedLifecycleKey,
  second: CapturedLifecycleKey,
): boolean {
  if (first.status !== second.status) return false;
  if (first.status !== "ok" || second.status !== "ok") return true;
  return first.keyEpochId === second.keyEpochId &&
    first.key.length === second.key.length &&
    timingSafeEqual(first.key, second.key);
}

/** Re-read the bound key and reject an in-place byte change with stable metadata. */
export async function assertLifecycleKeyObservationCurrent(
  namespace: PreparationLifecycleNamespaceV1,
  captured: CapturedLifecycleKey,
): Promise<void> {
  const current = await captureLifecycleKey(namespace);
  try {
    if (!sameCapturedKey(captured, current)) {
      throw new PreparationLifecycleNamespaceError(
        "namespace-changed",
        "preparation key authority changed during lifecycle observation",
      );
    }
  } finally {
    if (current.status === "ok") current.key.fill(0);
  }
}
