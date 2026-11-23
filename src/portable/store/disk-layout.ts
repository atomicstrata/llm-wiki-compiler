/**
 * @file src/portable/store/disk-layout.ts
 * @description Where a portable project's logical objects and its publication
 * ledger live inside an ordinary project directory.
 *
 * Curated namespaces map 1:1 onto today's layout, so registering a project
 * moves nothing. Proposals, approvals and the ledger live under
 * `.llmwiki/portable/`, a directory no legacy command lists: legacy review reads
 * only `.llmwiki/candidates/`, and legacy journal replay reads only
 * `.llmwiki/journal/`. That separation is what keeps a legacy command from
 * applying a portable candidate or rolling back a portable publication.
 *
 * This is the only module that turns a logical path into a filesystem one.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { PortableRefusal } from "../errors.js";
import { ACTIVE_PRODUCT_FILENAME } from "../../products/binding/store.js";
import {
  ACTIVE_PRODUCT_PATH,
  APPROVALS_PREFIX,
  CONFIG_PATH,
  PROFILE_PATH,
  PROPOSALS_PREFIX,
  STATE_CUSTODY_PATH,
  STATE_PATH,
  assertLogicalPath,
  SCOPED_STATE_PREFIX,
  ORIGINALS_PREFIX,
  isSafeRecordId,
} from "../logical-paths.js";

/** The portable directory inside a project. Its presence is feature discovery, never authority. */
export const PORTABLE_DIR = path.join(".llmwiki", "portable");

/** The adapter-private publication ledger. */
const LEDGER_DIR = path.join(PORTABLE_DIR, "ledger");

const EXACT_FILES: Readonly<Record<string, string>> = {
  [STATE_PATH]: path.join(".llmwiki", "state.json"),
  // Portable-owned: legacy commands never read or write it.
  [STATE_CUSTODY_PATH]: path.join(PORTABLE_DIR, "state-custody.json"),
  [CONFIG_PATH]: path.join(".llmwiki", "config.json"),
  [PROFILE_PATH]: path.join(".llmwiki", "profile.json"),
  [ACTIVE_PRODUCT_PATH]: path.join(".llmwiki", ACTIVE_PRODUCT_FILENAME),
  "meta/schema.json": path.join(".llmwiki", "schema.json"),
  "meta/schema.yaml": path.join(".llmwiki", "schema.yaml"),
  "meta/schema.yml": path.join(".llmwiki", "schema.yml"),
};

/** The project-relative file a logical path is stored at. */
export function relativeFileFor(logicalPath: string): string {
  assertLogicalPath(logicalPath);
  const exact = EXACT_FILES[logicalPath];
  if (exact) return exact;
  // Scoped-state records exist only on the authority-only store; a directory has no format for them (S2b).
  if (logicalPath.startsWith(SCOPED_STATE_PREFIX)) {
    throw new PortableRefusal("capability_unsupported", "scoped state records need authority-maintained custody");
  }
  // Retained originals exist only on the hosted originals store; a directory has no format for them (S3).
  if (logicalPath.startsWith(ORIGINALS_PREFIX)) throw new PortableRefusal("capability_unsupported", "stagedWrites");
  const isRecord = logicalPath.startsWith(PROPOSALS_PREFIX) || logicalPath.startsWith(APPROVALS_PREFIX);
  const segments = logicalPath.split("/");
  return isRecord ? path.join(PORTABLE_DIR, ...segments) : path.join(...segments);
}

/** True for a concept page, the one kind of object written through the page-apply primitive. */
export function conceptSlugOf(logicalPath: string): string | null {
  const match = /^wiki\/concepts\/([^/]+)\.md$/u.exec(logicalPath);
  return match ? match[1] : null;
}

/** The kinds of ledger record, each in its own directory. */
export type LedgerKind =
  | "identity" | "intents" | "started" | "receipts" | "closed" | "preimages" | "labels" | "reservations"
  /** Format 2 only: one marker per open operation, so recovery never scans every historical identity. */
  | "open";

/** Project-relative path of one ledger record. */
export function ledgerFile(kind: LedgerKind, name: string): string {
  if (!isSafeRecordId(name)) throw new PortableRefusal("operation_unsupported_on_portable_path", "unsafe ledger key");
  return path.join(LEDGER_DIR, kind, kind === "preimages" || kind === "started" ? name : `${name}.json`);
}

/** Project-relative directory holding one kind of ledger record. */
export function ledgerDir(kind: LedgerKind): string {
  return path.join(LEDGER_DIR, kind);
}

/** The project-relative directory a listing prefix (ending in `/`) is stored in. */
export function relativeDirFor(prefix: string): string {
  return path.dirname(relativeFileFor(`${prefix}entry`));
}

/** A filename-safe key for an arbitrary string (a logical path, an approval id). */
export function ledgerKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
