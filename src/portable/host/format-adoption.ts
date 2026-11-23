/**
 * @file src/portable/host/format-adoption.ts
 * @description Explicit, per-project adoption of portable format 2 by a
 * registered directory (S2b). It never happens on open, and there is no
 * downgrade (alignment §7.2 rule 5, §7.5).
 *
 * ORDER, so that no new ledger variant is ever visible while an older binary
 * may still mutate the project:
 *
 *  1. under the project mutation lock, refuse unless the ledger is quiet: no
 *     unresolved publication intent and no in-progress operation, every
 *     identity record readable, and `state.json` usable as a custody baseline;
 *  2. write the ADOPTING registration. Older portable-aware binaries refuse
 *     it (it is format 2), and so does every ordinary open or write of this
 *     binary (it carries a feature nothing supports);
 *  3. establish the format-2 ledger: the open-operation marker directory, a
 *     canonical `state.json` (an absent one becomes the empty state, so that
 *     format 2 can refuse a MISSING state as lost rather than guess it was
 *     never created) and the state-custody baseline of it;
 *  4. write the READY format-2 registration.
 *
 * DURABILITY. Steps 2–4 are power-loss durable (bytes and directory entries
 * synced) and each completes before the next starts, so a crash can never
 * keep a format-2 ledger variant while losing the exclusion of older writers,
 * nor keep READY while losing the ledger it promises. Existing state bytes are
 * never rewritten.
 *
 * An interruption after step 2 leaves the adopting registration, which only
 * this command resumes: it re-checks step 1 and redoes 3 and 4 idempotently.
 * Adoption never rewrites receipts, outcomes or labels.
 */

import { acquireMutationLockBlocking } from "../../operation-bundles/lock-gate.js";
import { releaseLock } from "../../utils/lock.js";
import { classifyStateText, emptyState, serializeState } from "../../utils/state.js";
import type { WikiState } from "../../utils/types.js";
import { recordBytes } from "../digest.js";
import { PortableHostError } from "../errors.js";
import { STATE_CUSTODY_PATH, STATE_PATH } from "../logical-paths.js";
import { custodyBaseline } from "../scoped-disk/custody.js";
import { ensureDurableDirectory, listEntries, readJsonRecord, readProjectFile, writeProjectFileDurable, type DirectoryEntry } from "../store/disk-io.js";
import { isIdentityRecord } from "../store/disk-open-operations.js";
import { unresolvedDiskIntents } from "../store/disk-intent.js";
import { ledgerDir, ledgerFile, relativeFileFor } from "../store/disk-layout.js";
import { isReplacingRecordTemp } from "../store/disk-record-entries.js";
import { ADOPTING_FEATURE, FORMAT2_FEATURES, REQUIRED_FEATURES, registrationMode } from "./control.js";
import { LocalHostControl } from "./local-control.js";

/** The bound on a state file or ledger record read during adoption: the disk object cap. */
const MAX_READ_BYTES = 1024 * 1024;

/** What every adoption result tells the operator, in plain words. */
const FORMAT2_CONSEQUENCE =
  "Format 2 is adopted for this project. Older portable-aware llmwiki binaries refuse to modify it, because they do not support a format-2 registration (verified for published 1.5.0; reading still works). Binaries that predate the portable path cannot be made to refuse and are unsupported. There is no downgrade.";

/** Points an interrupted adoption can be stopped at, for tests. */
export type AdoptionFaultStage = "after-adopting-control" | "after-custody";

/** What an adoption did. */
export interface AdoptionResult {
  kind: "adopted";
  formatVersion: 2;
  /** False when the project was already format 2 and nothing changed. */
  changed: boolean;
  /** What adoption means for older binaries, in plain words. */
  consequence: string;
}

/** Options: the host control root, and a test seam for interruption. */
export interface AdoptionOptions { controlRoot?: string; faultForTest?: (stage: AdoptionFaultStage) => void }

/**
 * Refuse unless no publication intent is unresolved and no operation is in
 * progress. Reads every identity ONCE. The replacing writer's exact temp
 * sibling of an identity record is skipped, untouched: the canonical record is
 * only ever replaced by rename, so it hides no work. Every other entry that is
 * not a readable, complete identity record still refuses by name.
 */
async function assertQuietLedger(root: string, projectId: string): Promise<void> {
  if ((await unresolvedDiskIntents(root)).length > 0) {
    throw new PortableHostError("a portable publication is unresolved; run `llmwiki project status`/`resolve` first");
  }
  // EVERY entry, regular or not: a directory or an unreadable record could hide in-progress work.
  for (const entry of await listEntries(root, ledgerDir("identity"))) {
    if (!isReplacingRecordTemp(entry)) await assertSettledIdentity(root, projectId, entry);
  }
}

/** The operation id an identity-ledger entry names: a regular `<id>.json` file, else `null`. */
function identityOperationId(entry: DirectoryEntry): string | null {
  return entry.regular && entry.name.endsWith(".json") ? entry.name.slice(0, -".json".length) : null;
}

/** One identity entry's record, read ONCE; `null` when the entry is not a regular `.json` file or cannot be read. */
async function readIdentityEntry(root: string, entry: DirectoryEntry): Promise<unknown> {
  const operationId = identityOperationId(entry);
  if (operationId === null) return null;
  return readJsonRecord<unknown>(root, ledgerFile("identity", operationId), MAX_READ_BYTES).catch(() => null);
}

/** Refuse an identity entry that is not a readable, complete record, or that records this project's operation still in progress. */
async function assertSettledIdentity(root: string, projectId: string, entry: DirectoryEntry): Promise<void> {
  const record = await readIdentityEntry(root, entry);
  if (!isIdentityRecord(record)) throw new PortableHostError(`identity record ${entry.name} is unreadable or malformed; adoption refuses`);
  if (record.project === projectId && record.outcome === "in-progress") {
    throw new PortableHostError(`operation ${record.operationId} is still in progress; settle it before adopting`);
  }
}

/** The canonical state as a custody baseline, `null` when absent; refuses a state file that cannot be one. */
async function stateBaseline(root: string): Promise<WikiState | null> {
  const bytes = await readProjectFile(root, relativeFileFor(STATE_PATH), MAX_READ_BYTES);
  const classified = classifyStateText(bytes === null ? null : bytes.toString("utf8"));
  if (classified.status === "corrupt" || classified.status === "too-new") {
    throw new PortableHostError(`.llmwiki/state.json is ${classified.status}; repair it before adopting`);
  }
  return bytes === null ? null : classified.state;
}

/** The canonical state, first durably creating an absent one as the empty state. */
async function canonicalState(root: string): Promise<WikiState> {
  const present = await stateBaseline(root);
  if (present !== null) return present;
  const state = emptyState();
  await writeProjectFileDurable(root, relativeFileFor(STATE_PATH), serializeState(state));
  return state;
}

/** Step 3: the marker directory, the canonical state and the custody baseline, idempotently and durably. */
async function establishLedger(root: string, projectId: string, options: AdoptionOptions): Promise<void> {
  const state = await canonicalState(root);
  await ensureDurableDirectory(root, ledgerDir("open"));
  await writeProjectFileDurable(root, relativeFileFor(STATE_CUSTODY_PATH), recordBytes(custodyBaseline(projectId, state)));
  options.faultForTest?.("after-custody");
}

/** Steps 1–4 under the project lock. */
async function adoptLocked(root: string, control: LocalHostControl, projectId: string, options: AdoptionOptions): Promise<void> {
  // Re-read under the lock: what is written back must be the CURRENT record, not one loaded before waiting.
  const record = await control.loadProject(projectId);
  const mode = record === null ? "unsupported" : registrationMode(record);
  if (record === null || (mode !== "format-1" && mode !== "adopting")) throw new PortableHostError("the registration changed while waiting for the project lock");
  await assertQuietLedger(root, record.projectId);
  await stateBaseline(root);
  if (mode === "format-1") {
    await control.saveProjectDurably({ ...record, formatVersion: 2, requiredFeatures: [...REQUIRED_FEATURES, ADOPTING_FEATURE] });
    options.faultForTest?.("after-adopting-control");
  }
  await establishLedger(root, record.projectId, options);
  await control.saveProjectDurably({ ...record, formatVersion: 2, requiredFeatures: [...REQUIRED_FEATURES, ...FORMAT2_FEATURES] });
}

/**
 * Adopt format 2 for the registered project at `root`, or resume an
 * interrupted adoption. Idempotent once adopted.
 *
 * @throws PortableHostError when the project is not registered, the
 *   registration is not this host's or not supported, or the ledger is not quiet.
 */
export async function adoptFormat2(root: string, options: AdoptionOptions = {}): Promise<AdoptionResult> {
  const control = await LocalHostControl.open(options.controlRoot);
  const record = await control.projectForRoot(root);
  if (record === null || record.canonicalRoot === null) throw new PortableHostError("this directory is not registered");
  if (record.hostIncarnation !== control.incarnation) throw new PortableHostError("this registration belongs to a host identity that no longer exists");
  const mode = registrationMode(record);
  if (mode === "format-2") return { kind: "adopted", formatVersion: 2, changed: false, consequence: FORMAT2_CONSEQUENCE };
  if (mode === "unsupported") throw new PortableHostError("this project's registration is not supported by this version");
  const canonicalRoot = record.canonicalRoot;
  await acquireMutationLockBlocking(canonicalRoot, "portable");
  try {
    await adoptLocked(canonicalRoot, control, record.projectId, options);
  } finally {
    await releaseLock(canonicalRoot);
  }
  return { kind: "adopted", formatVersion: 2, changed: true, consequence: FORMAT2_CONSEQUENCE };
}
