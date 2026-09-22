/**
 * @file src/preparations/lifecycle-fs/leaf-observation.ts
 * @description Handle-bound, bounded observation of lifecycle authority leaves
 * and planned objects. Higher classifier layers receive facts, never raw
 * filesystem capabilities.
 */

import {
  openConfinedLeaf,
  readConfirmedBufferOrElse,
} from "../../utils/confined-read.js";
import { lstatLeaf } from "../../utils/fs-presence.js";
import { verifyPlannedBytes } from "../../utils/planned-bytes.js";
import type { LifecycleScanBounds } from "./bounds.js";

/** Typed low-level observation refusal shared with record and state observers. */
export class LifecycleObservationError extends Error {
  constructor(
    readonly code:
      | "receipt-bytes-exhausted"
      | "object-bytes-exhausted"
      | "postcondition-bytes-exhausted"
      | "unit-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "LifecycleObservationError";
  }
}

/** Exact result of one bounded authority-leaf read. */
export type LifecycleLeafRead =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly body: Buffer };

/** Exact current state of one planned object path. */
export type LifecyclePlannedLeafState =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly dev: number; readonly ino: number };

/** Read one handle-bound lifecycle leaf, naming receipt-bound exhaustion. */
export async function readLifecycleLeaf(input: {
  root: string;
  file: string;
  expectedDir: string;
  maxBytes: number;
}): Promise<LifecycleLeafRead> {
  const opened = await openConfinedLeaf(
    input.root, input.file, input.expectedDir, { requireSingleLink: true },
  );
  if (opened.kind === "absent") return { status: "absent" };
  if (opened.kind !== "confirmed") {
    throw new LifecycleObservationError("unit-unavailable", "lifecycle leaf is unavailable");
  }
  if (opened.size > input.maxBytes) {
    await opened.handle.close().catch(() => {});
    throw new LifecycleObservationError(
      "receipt-bytes-exhausted",
      "lifecycle leaf exceeds its byte ceiling",
    );
  }
  const read = await readConfirmedBufferOrElse(
    opened, input.maxBytes, () => ({ kind: "oversize" as const }),
  );
  if (read.kind !== "ok") {
    throw new LifecycleObservationError(
      read.kind === "oversize" ? "receipt-bytes-exhausted" : "unit-unavailable",
      "lifecycle leaf could not be read exactly",
    );
  }
  return { status: "ok", body: Buffer.from(read.body) };
}

/** Whether one optional pre-plan leaf is a confined single-link regular file. */
export async function lifecycleRegularLeaf(
  root: string,
  file: string,
  expectedDir: string,
): Promise<boolean> {
  const opened = await openConfinedLeaf(root, file, expectedDir, { requireSingleLink: true });
  if (opened.kind !== "confirmed") return false;
  await opened.handle.close().catch(() => {});
  return true;
}

/** Reserve the real declared bytes before a present planned object is streamed. */
function reservePlannedBytes(
  byteCount: number,
  bounds: LifecycleScanBounds,
): void {
  if (byteCount > bounds.maxObjectBytes) {
    throw new LifecycleObservationError(
      "object-bytes-exhausted",
      "planned object exceeds the per-object verification ceiling",
    );
  }
  if (bounds.postconditionBytes + byteCount > bounds.maxPostconditionBytes) {
    throw new LifecycleObservationError(
      "postcondition-bytes-exhausted",
      "aggregate postcondition verification ceiling exhausted",
    );
  }
  bounds.postconditionBytes += byteCount;
}

/** Observe one absent or exact planned object through the shared streamed proof. */
export async function observeLifecyclePlannedLeaf(input: {
  root: string;
  file: string;
  expectedDir: string;
  object: { logicalPath: string; byteCount: number; digest: string | null };
  label: string;
  bounds: LifecycleScanBounds;
}): Promise<LifecyclePlannedLeafState> {
  const leaf = await lstatLeaf(input.file);
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") {
    throw new LifecycleObservationError("unit-unavailable", `${input.label} is unreadable`);
  }
  reservePlannedBytes(input.object.byteCount, input.bounds);
  try {
    const verified = await verifyPlannedBytes({
      root: input.root,
      file: input.file,
      expectedDir: input.expectedDir,
      plan: input.object,
      label: input.label,
      maxBytes: input.bounds.maxObjectBytes,
    });
    if (verified === "absent") {
      throw new LifecycleObservationError("unit-unavailable", `${input.label} vanished`);
    }
    return { status: "present", ...verified };
  } catch (error) {
    if (error instanceof LifecycleObservationError) throw error;
    throw new LifecycleObservationError(
      "unit-unavailable",
      `${input.label} failed verification: ${(error as Error).message}`,
    );
  }
}
