/**
 * @file src/portable/scoped-disk/disk-review.ts
 * @description How review and apply load, validate and complete a disk
 * scoped proposal: the hooks the shared review and apply protocol takes.
 *
 * Every load re-checks, inside the gate and before any proposal byte is read,
 * that the caller is bound and holds the verbs of the act, and that the
 * project is still format 2; every validation re-checks clearance for every
 * label the proposal carries. An approval carries that union, so every page
 * an apply writes carries it too.
 *
 * Apply publishes, in ONE intent and receipt: the approved pages, the
 * canonical `state.json` with exactly the completely covered sources' entries
 * merged into its CURRENT contents, and the state-custody record naming the
 * entries this apply established. State is an authoritative target with its
 * current pre-image — never a tail a crash could omit. The index and MOC
 * follow as a best-effort tail.
 */

import { classifyStateText, serializeState } from "../../utils/state.js";
import type { SourceState, WikiState } from "../../utils/types.js";
import type { LabelSet, Permission } from "../contracts.js";
import { normalizeLabels, recordBytes } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { STATE_CUSTODY_PATH, STATE_PATH } from "../logical-paths.js";
import type { ApplyCompanions, ApplyPath } from "../project/apply.js";
import { preImageIn } from "../project/proposal-records.js";
import type { ProposalVerifier } from "../project/review.js";
import type { ProjectRuntime } from "../project/runtime.js";
import { requireScopedAuthority } from "../scoped/scoped-authority.js";
import { clearedLoad } from "../scoped/scoped-review.js";
import type { DiskProjectStore } from "../store/disk-store.js";
import type { StoredWrite } from "../store/store.js";
import { custodyWith } from "./custody.js";
import type { DiskScopedWork } from "./disk-access.js";
import type { DiskScopedDependenciesV2 } from "./disk-contracts.js";
import { diskFormatRefusal } from "./disk-propose.js";
import { establishedEntries, loadDiskCoverage, loadDiskProposal, mergedState, type DiskScopedProposal } from "./disk-records.js";
import { readCanonicalState, readCustody } from "./disk-state.js";
import { diskDerivedTail } from "./disk-tail.js";
import { validateDiskDependencies } from "./disk-validate.js";

/** Refuse by name unless the project is format 2 now. */
async function requireFormat2(store: DiskProjectStore): Promise<void> {
  const refusal = await diskFormatRefusal(store);
  if (refusal !== null) throw new PortableRefusal(refusal, "this project has not adopted format 2");
}

/** The disk scoped proposal path for one act, re-checking binding, verbs, format and clearance at every load and validation. */
export function diskVerifier(
  runtime: ProjectRuntime, store: DiskProjectStore, verbs: readonly Permission[], work: DiskScopedWork,
): ProposalVerifier<DiskScopedDependenciesV2> {
  return {
    load: (view, proposalOperationId) => clearedLoad(runtime, verbs, view, proposalOperationId, loadDiskProposal),
    validate: async (_store, proposal) => {
      await requireFormat2(store);
      const coverage = await loadDiskCoverage(store, proposal.receipt.operationId);
      const { record } = await requireScopedAuthority(runtime, verbs, proposal.labels);
      await validateDiskDependencies(store, proposal.dependencies, { bounds: coverage.scope.bounds, counters: work.validate, compartment: record.compartment });
    },
    approvalLabels: (proposal) => proposal.labels,
  };
}

/** The labels `path` carries after this apply: the apply's, never fewer than its own binding (exact, else latest) now. */
async function labelFloor(store: DiskProjectStore, path: string, labels: LabelSet): Promise<LabelSet> {
  const seen = await store.observe(path);
  const current = (seen === null ? null : await store.labelsFor(path, seen.digest)) ?? (await store.lastLabels(path)) ?? [];
  return normalizeLabels([...labels, ...current]);
}

/**
 * The merged canonical state as it will be stored, and each established
 * entry exactly as it will be READ BACK — attestations, typed mirror and all —
 * so the custody digest names what was actually established.
 */
function mergedForStore(current: WikiState, entries: Readonly<Record<string, SourceState>>): { text: string; established: Record<string, SourceState> } {
  const text = serializeState(mergedState(current, entries));
  const readBack = classifyStateText(text).state;
  return { text, established: Object.fromEntries(Object.keys(entries).map((source) => [source, readBack.sources[source]])) };
}

/** The state and custody writes of one apply, or none when it completes no source. */
async function stateWrites(store: DiskProjectStore, proposal: DiskScopedProposal, pages: readonly StoredWrite[], labels: LabelSet): Promise<StoredWrite[]> {
  const operationId = proposal.receipt.operationId;
  const coverage = await loadDiskCoverage(store, operationId);
  const compiledAt = (await store.getReceipt(operationId))?.committedAt ?? "";
  const entries = establishedEntries(proposal, coverage, new Set(pages.map((page) => page.path)), compiledAt);
  if (Object.keys(entries).length === 0) return [];
  const merged = mergedForStore((await readCanonicalState(store)).state, entries);
  const { custody } = await readCustody(store, store.projectId);
  return [
    { path: STATE_PATH, bytes: Buffer.from(merged.text, "utf8"), pre: await preImageIn(store, STATE_PATH), labels: await labelFloor(store, STATE_PATH, labels) },
    {
      path: STATE_CUSTODY_PATH, bytes: recordBytes(custodyWith(custody, merged.established, operationId)),
      pre: await preImageIn(store, STATE_CUSTODY_PATH), labels: await labelFloor(store, STATE_CUSTODY_PATH, labels),
    },
  ];
}

/** The disk scoped apply: pages, state and custody in the batch; the derived views as the tail. */
export function diskApplyPath(runtime: ProjectRuntime, store: DiskProjectStore, verbs: readonly Permission[], work: DiskScopedWork): ApplyPath {
  return {
    verifier: diskVerifier(runtime, store, verbs, work) as ProposalVerifier,
    admit: () => diskFormatRefusal(store),
    companions: async (_store, proposal, pages, _applied, labels): Promise<ApplyCompanions> => {
      const writes = await stateWrites(store, proposal as DiskScopedProposal, pages, labels);
      return { writes, tail: await diskDerivedTail(runtime, store, [...pages, ...writes], labels) };
    },
  };
}
