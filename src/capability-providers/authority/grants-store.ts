/**
 * @file src/capability-providers/authority/grants-store.ts
 * @description Confined, capped, durable provider grant persistence under the
 * existing provider operator lock. Reads never create roots and preserve the
 * distinction between absent, unreadable, and malformed authority.
 */
import path from "node:path";
import { lstat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { atomicWrite } from "../../utils/atomic-write.js";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import { assertAuthorizedProviderPaths } from "../packages/paths.js";
import { withProviderStateLock } from "../packages/state-store.js";
import {
  MAX_PROVIDER_GRANT_STATE_BYTES, parseProviderGrantState,
} from "./grants-parse.js";
import type {
  ProviderGrantStateReadV1, ProviderOperatorGrantRecordV1, ProviderOperatorGrantStateV1,
} from "./types.js";

const GRANTS_FILENAME = "provider-grants.json";
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Honest result for one confined, capped, fatal-UTF-8 authority leaf read. */
export type ProviderAuthorityTextReadV1 =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "invalid" };

/** Reuse the authority-store trust boundary without treating malformed bytes as absence. */
export async function readProviderAuthorityText(
  paths: AuthorizedProviderPaths,
  filename: string,
  maximumBytes: number,
): Promise<ProviderAuthorityTextReadV1> {
  try {
    await assertAuthorizedProviderPaths(paths);
    const root = await lstat(paths.configRoot).catch((error) => absentOrThrow(error));
    if (root === null) return Object.freeze({ kind: "absent" });
    if (!root.isDirectory() || root.isSymbolicLink()) return Object.freeze({ kind: "unreadable" });
    const file = path.join(paths.configRoot, filename);
    const read = await readConfinedLeafBuffer(paths.configRoot, file, paths.configRoot, maximumBytes);
    if (read.kind === "absent") return Object.freeze({ kind: "absent" });
    if (read.kind !== "ok") return Object.freeze({ kind: "unreadable" });
    try { return Object.freeze({ kind: "ok", text: STRICT_UTF8.decode(read.body) }); }
    catch { return Object.freeze({ kind: "invalid" }); }
  } catch { return Object.freeze({ kind: "unreadable" }); }
}

/** Read provider grant authority without creating or repairing any state. */
export async function readProviderGrantState(
  paths: AuthorizedProviderPaths,
): Promise<ProviderGrantStateReadV1> {
  const read = await readProviderAuthorityText(
    paths, GRANTS_FILENAME, MAX_PROVIDER_GRANT_STATE_BYTES,
  );
  if (read.kind !== "ok") return read;
  try { return Object.freeze({ kind: "ok", state: parseProviderGrantState(read.text) }); }
  catch { return Object.freeze({ kind: "invalid" }); }
}

/** Append one host-derived operator grant under the shared provider lock. */
export async function appendProviderOperatorGrant(
  paths: AuthorizedProviderPaths,
  record: ProviderOperatorGrantRecordV1,
): Promise<void> {
  await withProviderStateLock(paths, async () => {
    const read = await readProviderGrantState(paths);
    if (read.kind === "unreadable" || read.kind === "invalid") throw storeError();
    const state = read.kind === "absent" ? emptyGrantState() : read.state;
    if (state.grants[record.grantId]) throw new Error("provider grant already exists");
    const next = Object.freeze({
      schemaVersion: 1 as const,
      grants: Object.freeze({ ...state.grants, [record.grantId]: record }),
    });
    await writeGrantState(paths, next);
  });
}

function emptyGrantState(): ProviderOperatorGrantStateV1 {
  return Object.freeze({ schemaVersion: 1, grants: Object.freeze({}) });
}

async function writeGrantState(
  paths: AuthorizedProviderPaths,
  state: ProviderOperatorGrantStateV1,
): Promise<void> {
  await assertAuthorizedProviderPaths(paths);
  const text = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_PROVIDER_GRANT_STATE_BYTES) throw storeError();
  parseProviderGrantState(text);
  await atomicWrite(path.join(paths.configRoot, GRANTS_FILENAME), text, {
    confineRoot: paths.configRoot, exactParent: true, durable: true,
    strictDurability: true, mode: 0o600,
  });
}

function absentOrThrow(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

function storeError(): Error { return new Error("provider grant store is unavailable"); }
