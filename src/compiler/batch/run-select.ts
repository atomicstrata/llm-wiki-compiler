/**
 * @file src/compiler/batch/run-select.ts
 * @description Which run a batch compile works on, and the checks that make a
 * resumed run safe to continue BEFORE it has any further effect.
 *
 * SELECTION. With no active run, a new one is created, its identity holding
 * the policy digest and the compile-state manifest digest it starts from
 * (the source-set digest is recorded once the listing finishes). An active
 * run is resumed (a new attempt); with `restart` it is first SUPERSEDED (its
 * pages stay as written; its state was never committed unless it reached its
 * finalize step, in which case the new run starts from that state) and a new
 * run is created. A new or replacement run must fit the complete indexed
 * inventory. Resuming an existing run takes no slot.
 *
 * REVALIDATION of a resumed run, before any further effect: the policy
 * digest must be unchanged; until the run's own state commit (after it, the
 * compile state's meta names the run) the compile state must still be the
 * manifest the run started from; and (in the phase loop, once its listing is
 * complete and before any later phase) every selected source is walked again
 * and re-hashed, and the walk must find exactly the listed sources with their
 * listed hashes. Any difference refuses with `compile_batch_inputs_changed`
 * (`--restart` starts over from the current inputs).
 *
 * POLICY DIGEST. The prompt-modifier digest, the extraction fingerprint
 * (contract, provider, model), the schema, the custom profile's digest, the
 * system policy and the review policy.
 */

import { createHash } from "node:crypto";
import { compileStateMetaOf } from "../../cstate/contracts.js";
import { openCompileState } from "../../cstate/store.js";
import { loadNonDefaultProfile } from "../../profile/block.js";
import { MAX_INDEXED_STORE_ENTRIES } from "../../segments/contracts.js";
import type { ReviewPolicy } from "../../review/policy.js";
import type { SchemaConfig } from "../../schema/index.js";
import type { LegacyLocalReads } from "../../storage/legacy-local-reads.js";
import { extractionFingerprint } from "../extraction-snapshot.js";
import { promptModifiersDigest } from "../prompt-modifiers.js";
import { BatchCompileError } from "./contracts.js";
import { BatchRun, inspectActiveRun, manifestDigest } from "./run-store.js";

/** What one compile asks of its run. */
export interface RunRequest {
  readonly root: string;
  readonly reads: LegacyLocalReads;
  readonly policy: string;
  readonly batchSize: number;
  readonly restart: boolean;
}

/** The policy digest of this compile: a run never resumes under a different prompt, schema, profile or policy. */
export async function policyDigest(root: string, schema: SchemaConfig, reviewPolicy: ReviewPolicy, systemPolicy: string | undefined): Promise<string> {
  const profile = await loadNonDefaultProfile(root);
  const parts: unknown[] = [promptModifiersDigest(), extractionFingerprint(), schema, profile?.digest ?? null, systemPolicy ?? null, reviewPolicy];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Refuse a resumed run whose inputs changed. */
const changed = (what: string): never => {
  throw new BatchCompileError("compile_batch_inputs_changed", `${what} changed since the batch compile run began; run the compile with --restart to start over from the current inputs`);
};

/**
 * Check a resumed run's identity before it continues: the policy always; the
 * compile state only until the run's own state commit, which is the one
 * change of it the run itself makes. (Its sources are re-checked by the
 * phase loop once its listing is complete: `assertListingCurrent`.) Reads
 * only, so it runs on a read-only open of the run, before any attempt is
 * recorded.
 */
async function revalidateRun(run: BatchRun, request: Pick<RunRequest, "root" | "policy">): Promise<void> {
  if (run.meta.identity.policy !== request.policy) changed("the compile policy (prompt modifiers, schema, profile, provider, model or review policy)");
  const store = await openCompileState(request.root);
  const committedByRun = compileStateMetaOf(store).lastRun === run.runId;
  if (!committedByRun && manifestDigest(store) !== run.meta.identity.cstate) changed("the compile state");
}

/** Explain which safe actions remain when a run cannot be created. */
function refuseNewRun(active: string | null): never {
  const limit = `the indexed directory has reached its limit of ${MAX_INDEXED_STORE_ENTRIES} entries`;
  if (active === null) throw new BatchCompileError("compile_batch_run_unknown", `${limit}; preview eligible finished runs with \`llmwiki catalog runs\` and retire enough to free a slot`);
  throw new BatchCompileError("compile_batch_run_active", `${limit}; cannot restart run ${active} without a free slot. Try to resume without --restart if its inputs still match. If it cannot resume, preserve the project and seek recovery`);
}

/** Create a new run from the current compile state. */
async function createRun(request: RunRequest): Promise<BatchRun> {
  const cstate = manifestDigest(await openCompileState(request.root));
  return BatchRun.create(request.root, { batchSize: request.batchSize, embeddings: false, identity: { policy: request.policy, sources: null, cstate } });
}

/**
 * The run this compile works on (see the file comment). A resume is validated
 * on a READ-ONLY open first, so a refused policy, selection or compile state
 * records no attempt and publishes nothing; only then is the attempt recorded
 * (under the compile's lock). A restart supersedes the active run whatever its
 * identity, as before.
 */
export async function selectRun(request: RunRequest): Promise<BatchRun> {
  const { active, atCapacity } = await inspectActiveRun(request.root);
  if (active !== null && !request.restart) {
    await revalidateRun(await BatchRun.open(request.root, active), request);
    return BatchRun.resume(request.root, active);
  }
  if (atCapacity) refuseNewRun(active);
  if (active === null) return createRun(request);
  const run = await BatchRun.resume(request.root, active);
  await run.advance("superseded");
  return createRun(request);
}
