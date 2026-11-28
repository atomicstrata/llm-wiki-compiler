/**
 * @file src/portable/scoped-disk/disk-propose.ts
 * @description `proposal.persist` over a declared disk scope: the same
 * three-step proposal protocol as version 1 and slice S2a (lease under the
 * gate, generate outside it, persist under it again), over a registered
 * directory that has adopted format 2.
 *
 * Before the model runs, against current host state: the caller is bound and
 * holds the scoped verbs; the project is format 2; the scope is within the
 * disk bounds; the concept directory is within the title bound; the canonical
 * state and its custody are present and well formed; and the shared-concept
 * closure is decided from the canonical owners, refusing a source whose entry
 * custody knew and that has disappeared. Nothing lost is recompiled by spending.
 *
 * At persist, under the gate: the plan is re-checked against the scope; a
 * candidate for a KEPT page (a slug the canonical state freezes) is held back
 * and its sources reported incomplete, since the shared compile is not given
 * kept-page decisions; legacy bytes the compile was given are bound to their
 * reconciled labels; and every dependency is validated before any record is written.
 */

import { runReviewProposal } from "../../compiler/compile-phases.js";
import { withQuiet } from "../../utils/output.js";
import { runWithProviderOverride } from "../../utils/provider.js";
import type { ReviewCandidate } from "../../utils/types.js";
import type { OperationRequest, ResolvedPublication } from "../authority/authority.js";
import type { OperationIdentityRecordV1, ProposalOutcome, RefusalCode, SkippedItem } from "../contracts.js";
import { normalizeLabels, recordDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { CONCEPTS_PREFIX, conceptPagePath } from "../logical-paths.js";
import { partitionByFloor, runGeneratedProposal, type GenerationSteps, type PolicyFence } from "../project/propose.js";
import { buildRecordBatch, planEntriesIn, type PlanTarget } from "../project/proposal-records.js";
import { requireHostModel, type ProjectRuntime } from "../project/runtime.js";
import { decideClosure, type Closure, type OwnershipView } from "../scoped/closure.js";
import { boundCandidates, settledCoverage } from "../scoped/coverage.js";
import { scopedAuthority, SCOPED_VERBS } from "../scoped/scoped-authority.js";
import { scopedProposeOperation } from "../scoped/scoped-propose.js";
import type { DiskProjectStore } from "../store/disk-store.js";
import { DiskScopedCompileAccess, type DiskScopedWork, type PendingReconciliation } from "./disk-access.js";
import {
  DISK_SCOPED_PROTOCOL_V2, type DiskCompileScopeV2, type DiskScopedCoverageV2, type DiskScopedDependenciesV2, type DiskScopedProposeRequestV2,
} from "./disk-contracts.js";
import { diskProposalPaths } from "./disk-records.js";
import { admittedDiskScope, receivedDiskScope, type ReceivedDiskScope } from "./disk-scope.js";
import { ownerEntries, ownershipOf, readCanonicalState, readCustody, refuseLostEntries, type CanonicalState } from "./disk-state.js";
import { validateDiskDependencies } from "./disk-validate.js";

const UNSUPPORTED = "operation_unsupported_on_portable_path";

/**
 * Host-private hooks a caller that drives the protocol itself (slice S5) may
 * pass. With none, every step is exactly the ordinary disk scoped propose.
 */
interface DiskScopedHooks {
  /** Told of the generation's access as soon as it exists, before any compile read. */
  accessCreated?(access: DiskScopedCompileAccess): void;
  /** Further create-only records the proposal batch publishes, with the proposal's labels and receipt. */
  extraRecords?(): readonly { path: string; value: unknown }[];
}

/** What generation hands to persistence, inside the host only. */
interface DiskGeneration {
  access: DiskScopedCompileAccess; scope: DiskCompileScopeV2; closure: Closure; ownership: OwnershipView;
  canonical: CanonicalState; compartment: string;
}

/** `capability_unsupported` unless the project has adopted format 2, decided from the current registration. */
export async function diskFormatRefusal(store: DiskProjectStore): Promise<RefusalCode | null> {
  return (await store.registrationMode()) === "format-2" ? null : "capability_unsupported";
}

/** Refuse a concept directory larger than the title bound, from its listing alone, before the model runs. */
async function refuseOverTitleBound(store: DiskProjectStore, scope: DiskCompileScopeV2): Promise<void> {
  if ((await store.list(CONCEPTS_PREFIX)).length > scope.bounds.maxTitleEntries) throw new PortableRefusal("limit_exceeded", "title entries");
}

/** The canonical state, its ownership table and the access over them; the state handed over before any decision uses it. */
async function openGeneration(
  runtime: ProjectRuntime, store: DiskProjectStore, scope: DiskCompileScopeV2, work: DiskScopedWork, hooks: DiskScopedHooks,
): Promise<Omit<DiskGeneration, "closure">> {
  const authority = await scopedAuthority(runtime, SCOPED_VERBS.propose);
  if (authority === null) throw new PortableRefusal("permission_denied");
  await refuseOverTitleBound(store, scope);
  const canonical = await readCanonicalState(store);
  const { custody, observed: custodyObserved } = await readCustody(store, store.projectId);
  const access = new DiskScopedCompileAccess({
    store, scope, canonical, custody: custodyObserved, compartment: authority.record.compartment, counters: work.propose,
    allowedSources: scope.sources.names,
    reauthorize: async () => (await scopedAuthority(runtime, SCOPED_VERBS.propose))?.clearances ?? null,
  });
  hooks.accessCreated?.(access);
  // Owners, losses and kept-page decisions are protected facts of the state: it is authorized before they decide anything.
  await access.handOverState();
  refuseLostEntries(custody, canonical.state);
  return { access, scope, ownership: ownershipOf(canonical.state), canonical, compartment: authority.record.compartment };
}

/** STEP 2: admit the scope, read the canonical state once, decide the closure, and run the shared compile. */
async function generateDisk(
  runtime: ProjectRuntime, store: DiskProjectStore, received: ReceivedDiskScope, work: DiskScopedWork, hooks: DiskScopedHooks,
): Promise<DiskGeneration> {
  const scope = admittedDiskScope(received);
  const opened = await openGeneration(runtime, store, scope, work, hooks);
  const closure = decideClosure(opened.ownership, scope);
  opened.access.expandTo(closure.expanded);
  await runWithProviderOverride(requireHostModel(runtime), () => withQuiet(() => runReviewProposal(opened.access, { review: true })));
  return { ...opened, closure };
}

/** Refuse a plan that reaches outside the declared scope before any record is written. */
function assertPlanInScope(candidates: readonly Pick<ReviewCandidate, "slug" | "sources">[], generated: DiskGeneration): void {
  const readable = new Set([...generated.scope.sources.names, ...generated.closure.expanded]);
  for (const candidate of candidates) {
    const isFlatPage = !candidate.slug.includes("/") && conceptPagePath(candidate.slug).startsWith(CONCEPTS_PREFIX);
    if (!isFlatPage || !candidate.sources.every((source) => readable.has(source))) throw new PortableRefusal(UNSUPPORTED, "plan outside the declared scope");
  }
}

/** What persistence is built from: the kept candidates with their targets, the skips, and the coverage. */
interface BoundedPlan {
  entries: { candidate: ReviewCandidate; target: PlanTarget }[];
  skipped: SkippedItem[];
  coverage: DiskScopedCoverageV2;
}

/** Hold back every candidate for a kept page: the compile was not told the page is kept, so it must not be overwritten. */
function holdKeptPages(generated: DiskGeneration): { candidates: ReviewCandidate[]; held: Map<string, "kept_page">; skipped: SkippedItem[] } {
  const keptSlugs = new Set(generated.canonical.state.frozenSlugs ?? []);
  const held = new Map<string, "kept_page">();
  // Reported as `limit_exceeded`, the closed V1 code S2a also uses for a target this path cannot write; coverage says why.
  const skipped: SkippedItem[] = [];
  const candidates = generated.access.candidates.filter((candidate) => {
    if (!keptSlugs.has(candidate.slug)) return true;
    held.set(candidate.slug, "kept_page");
    skipped.push({ path: conceptPagePath(candidate.slug), code: "limit_exceeded" });
    return false;
  });
  return { candidates, held, skipped };
}

/** Check the plan against the scope, hold back kept pages, then floor, guard and bound the candidates and state the coverage. */
async function boundedPlan(store: DiskProjectStore, generated: DiskGeneration): Promise<BoundedPlan> {
  const { access, scope, closure } = generated;
  const pathOf = (candidate: ReviewCandidate): string => conceptPagePath(candidate.slug);
  assertPlanInScope([...access.candidates, ...access.dropped], generated);
  const kept = holdKeptPages(generated);
  const floor = await partitionByFloor(kept.candidates, pathOf);
  const readable = new Set([...scope.sources.names, ...closure.expanded]);
  const bounded = boundCandidates(floor.allowed, [...kept.skipped, ...floor.skipped], scope, { pathOf, snapshot: generated.ownership, readable });
  const coverage = settledCoverage(access, {
    scope, closure, bounded, floored: kept.candidates, allowed: floor.allowed, held: kept.held, pathOfSlug: conceptPagePath,
  });
  return { entries: await planEntriesIn(store, bounded.kept, pathOf), skipped: bounded.skipped, coverage };
}

/** The dependency record, refused when it exceeds the declared bound. */
function dependenciesOf(generated: DiskGeneration, plan: BoundedPlan): DiskScopedDependenciesV2 {
  const { access, scope, closure, ownership } = generated;
  const guarded = [...access.candidates, ...access.dropped].map((candidate) => conceptPagePath(candidate.slug));
  const owners = ownerEntries(ownership, [...closure.consulted, ...guarded]);
  const forms = [...access.recordedForms(), { form: "state-owners" as const, entries: owners }];
  const targets = plan.entries.map(({ target }) => ({ path: target.path, pre: target.pre }));
  const entryCount = forms.reduce((count, form) => count + (form.form === "state-owners" ? form.entries.length : 1), 0);
  if (entryCount + targets.length > scope.bounds.maxDependencies) throw new PortableRefusal("limit_exceeded", "dependencies");
  return { protocol: DISK_SCOPED_PROTOCOL_V2, scopeDigest: recordDigest(scope), forms, targets };
}

/**
 * Bind, under the gate, the reconciled labels of legacy bytes the compile was
 * given — only while those exact bytes are still current and still unbound,
 * and never below the path's latest binding now. Each binding is audited.
 */
async function bindReconciled(runtime: ProjectRuntime, store: DiskProjectStore, pending: readonly PendingReconciliation[]): Promise<void> {
  for (const item of pending) {
    const seen = await store.observe(item.path);
    if (seen?.digest !== item.digest || (await store.labelsFor(item.path, item.digest)) !== null) continue;
    const labels = normalizeLabels([...((await store.lastLabels(item.path)) ?? []), ...item.labels]);
    await store.reconcileLabels(item.path, item.digest, labels);
    runtime.control.audit({ kind: "label-reconciled", project: store.projectId, path: item.path, digest: item.digest });
  }
}

/** STEP 3 body: bound the plan, record coverage and dependencies, bind reconciled labels, validate against the current head. */
async function resolveDisk(
  runtime: ProjectRuntime, store: DiskProjectStore, generated: DiskGeneration,
  persist: { record: OperationIdentityRecordV1; fence: PolicyFence; work: DiskScopedWork; hooks: DiskScopedHooks },
): Promise<ResolvedPublication> {
  const { record, fence } = persist;
  const plan = await boundedPlan(store, generated);
  const dependencies = dependenciesOf(generated, plan);
  await bindReconciled(runtime, store, generated.access.pendingReconciliations());
  const paths = diskProposalPaths(record.operationId);
  const { writes, receipt } = buildRecordBatch({
    operationId: record.operationId, intentDigest: record.intentDigest, entries: plan.entries, skipped: plan.skipped,
    labels: normalizeLabels([generated.compartment, ...generated.access.consumedLabels()]),
    dependencies: { path: paths.readSet, value: dependencies },
    extra: [{ path: paths.coverage, value: plan.coverage }, ...(persist.hooks.extraRecords?.() ?? [])],
  });
  await validateDiskDependencies(store, dependencies, { bounds: generated.scope.bounds, counters: persist.work.validate, compartment: generated.compartment });
  return {
    writes, tail: [], skipped: plan.skipped, onBehalfOf: [], proposal: receipt, policyFence: fence,
    consumedApprovalId: null, consumedTicketId: null,
  };
}

/**
 * Propose changes from a declared disk scope by running the real review-mode
 * compile inside the host. A same-id retry of a committed proposal returns the
 * recorded proposal and does not run the model again.
 */
export async function proposeDiskScoped(
  runtime: ProjectRuntime, store: DiskProjectStore, request: DiskScopedProposeRequestV2, work: DiskScopedWork,
): Promise<ProposalOutcome> {
  const { operation, steps } = diskScopedSteps(runtime, store, request, work);
  return runGeneratedProposal(runtime, operation, steps);
}

/**
 * The operation and the generation steps of one disk scoped propose: the
 * same steps {@link proposeDiskScoped} composes, for a caller that drives the
 * three-step protocol itself. `hooks` are host-private.
 */
function diskScopedSteps(
  runtime: ProjectRuntime, store: DiskProjectStore, request: DiskScopedProposeRequestV2, work: DiskScopedWork, hooks: DiskScopedHooks = {},
): { operation: OperationRequest; steps: GenerationSteps<DiskGeneration> } {
  const received = receivedDiskScope(request.scope);
  const operation = scopedProposeOperation(runtime, request, DISK_SCOPED_PROTOCOL_V2, received.digestInput);
  const steps: GenerationSteps<DiskGeneration> = {
    extraCheck: async () => (await diskFormatRefusal(store))
      ?? ((await scopedAuthority(runtime, SCOPED_VERBS.propose)) === null ? "permission_denied" : null),
    generate: () => generateDisk(runtime, store, received, work, hooks),
    resolve: (record, generated, fence) => resolveDisk(runtime, store, generated, { record, fence, work, hooks }),
  };
  return { operation, steps };
}
