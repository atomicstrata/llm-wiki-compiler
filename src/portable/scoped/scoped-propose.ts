/**
 * @file src/portable/scoped/scoped-propose.ts
 * @description `proposal.persist` over a declared scope: the same three-step
 * proposal protocol as version 1 (lease under the gate, generate outside it,
 * persist under it again), with a generation that reads only the scope and a
 * resolution that records exactly what was read.
 *
 * Before the model runs, and against current host state: the caller must be
 * bound to this tenant, project and store and hold the scoped verbs; the scope
 * must be within the declared and host bounds; the shared-concept closure is
 * decided from the authoritative ownership table, bounded, and refused when a
 * source in it has unknown state. Everything the compile is given then comes
 * from ONE pin of the head and the namespace table.
 *
 * At persist the plan is re-checked against the scope: every target must lie in
 * the selected namespace and every contributing source in the closure, or the
 * proposal is refused before any record is written. Candidates beyond the
 * declared count and byte bounds are skipped, and their sources reported incomplete.
 */

import { runReviewProposal } from "../../compiler/compile-phases.js";
import { withQuiet } from "../../utils/output.js";
import { runWithProviderOverride } from "../../utils/provider.js";
import type { ReviewCandidate } from "../../utils/types.js";
import { intentDigestOf, type OperationRequest, type ResolvedPublication } from "../authority/authority.js";
import type { LabelSet, OperationIdentityRecordV1, ProposalOutcome, SkippedItem } from "../contracts.js";
import { normalizeLabels, recordDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { isCleared } from "../host/policy.js";
import { partitionByFloor, runGeneratedProposal, type PolicyFence } from "../project/propose.js";
import { buildRecordBatch, planEntriesIn, type PlanTarget } from "../project/proposal-records.js";
import { requireHostModel, type ProjectRuntime } from "../project/runtime.js";
import { decideClosure, type Closure } from "./closure.js";
import {
  SCOPED_PROTOCOL_V2, type CompileScopeV2, type ScopedDependenciesV2, type ScopedDependencyV2, type ScopedProposeRequestV2, type ScopedCoverageV2,
} from "./contracts.js";
import { boundCandidates, settledCoverage } from "./coverage.js";
import { namespaceOf, namespacedPagePath, scopedProposalPaths } from "./namespaces.js";
import { assertScopeAdmitted } from "./scope.js";
import { ScopedCompileAccess } from "./scoped-access.js";
import { requireScopedAuthority, scopedAuthority, SCOPED_VERBS } from "./scoped-authority.js";
import type { ScopedPin, ScopedStoreSurface } from "./store-types.js";
import { validateScopedDependencies } from "./scoped-validate.js";

const UNSUPPORTED = "operation_unsupported_on_portable_path";

/** What generation hands to persistence, inside the host only. */
interface ScopedGeneration {
  access: ScopedCompileAccess; pin: ScopedPin; scope: CompileScopeV2; closure: Closure; compartment: string;
}

/** Refuse a named source already compiled into another namespace: moving one is not in S2a. */
function refuseMovedSources(pin: ScopedPin, scope: CompileScopeV2): void {
  for (const name of scope.sources.names) {
    const bound = pin.sourceNamespaces.get(name);
    if (bound !== undefined && bound !== scope.namespace.name) throw new PortableRefusal(UNSUPPORTED, "source compiled into another namespace");
  }
}

/** Refuse a namespace with more titles than the scope admits, from its recorded count. */
function refuseOverTitleBound(size: number, scope: CompileScopeV2): void {
  if (size > scope.bounds.maxTitleEntries) throw new PortableRefusal("limit_exceeded", "title entries");
}

/**
 * Pin the head and namespace table once, with the context query answered from
 * a CURRENT index (rebuilt first if lost or behind). The title bound is checked
 * from the recorded count before any rebuild or pin work, and again on the pin.
 */
async function pinForScope(store: ScopedStoreSurface, scope: CompileScopeV2, labelSets: readonly LabelSet[]): Promise<ScopedPin> {
  const namespace = scope.namespace.name;
  refuseOverTitleBound(store.currentNamespaces().get(namespace)?.members.size ?? 0, scope);
  const { context } = scope;
  if (context !== null) await store.ensureNamespaceIndex(namespace, scope.bounds.maxTitleEntries);
  const query = context === null ? null : { namespace, text: context.query, k: context.k, scanBudget: context.scanBudget, labelSets };
  const pin = store.pinScoped(query);
  const size = pin.namespaces.get(namespace)?.members.size ?? 0;
  refuseOverTitleBound(size, scope);
  // A bind that landed between the rebuild and the pin leaves it behind again: refuse rather than give empty context.
  if (context !== null && pin.context?.index === null && size > 0) {
    throw new PortableRefusal(UNSUPPORTED, "context index behind; retry after it is rebuilt");
  }
  return pin;
}

/** STEP 2: decide the closure, pin once, and run the shared compile through the scoped access. */
async function generateScoped(runtime: ProjectRuntime, store: ScopedStoreSurface, received: CompileScopeV2 | null): Promise<ScopedGeneration> {
  if (received === null) throw new PortableRefusal(UNSUPPORTED, "malformed scope");
  const scope = received;
  assertScopeAdmitted(scope);
  const authority = await scopedAuthority(runtime, SCOPED_VERBS.propose);
  if (authority === null) throw new PortableRefusal("permission_denied");
  const pin = await pinForScope(store, scope, store.partitionLabelSets().filter((labels) => isCleared(authority.clearances, labels)));
  refuseMovedSources(pin, scope);
  const closure = decideClosure(pin.namespaces.get(scope.namespace.name), scope);
  const access: ScopedCompileAccess = await ScopedCompileAccess.create({
    pin, scope, allowedSources: [...scope.sources.names, ...closure.expanded], clearances: authority.clearances,
    counters: store.scopedCounters, current: store,
    reauthorize: async () => (await scopedAuthority(runtime, SCOPED_VERBS.propose))?.clearances ?? null,
  });
  // A co-owner's name is protected metadata: authorized, labelled and recorded before it shapes anything.
  await access.noteSourceFacts([...closure.expanded, ...closure.frontier]);
  await runWithProviderOverride(requireHostModel(runtime), () => withQuiet(() => runReviewProposal(access, { review: true })));
  return { access, pin, scope, closure, compartment: authority.record.compartment };
}

/** Refuse a plan that reaches outside the declared scope before any record is written. */
function assertPlanInScope(candidates: readonly Pick<ReviewCandidate, "slug" | "sources">[], generated: ScopedGeneration): void {
  const readable = new Set([...generated.scope.sources.names, ...generated.closure.expanded]);
  const namespace = generated.scope.namespace.name;
  for (const candidate of candidates) {
    const inNamespace = namespaceOf(namespacedPagePath(namespace, candidate.slug)) === namespace;
    if (!inNamespace || !candidate.sources.every((source) => readable.has(source))) {
      throw new PortableRefusal(UNSUPPORTED, "plan outside the declared scope");
    }
  }
}

/** Every dependency form: what the access recorded, the owner lists consulted, and any retrieval. */
function dependencyForms(generated: ScopedGeneration, targets: readonly string[]): ScopedDependencyV2[] {
  const { access, pin, scope } = generated;
  const snapshot = pin.namespaces.get(scope.namespace.name);
  const consulted = [...new Set([...generated.closure.consulted, ...targets])].sort();
  const entries = consulted.map((path) => ({ path, owners: snapshot?.owners.get(path) ?? [] }));
  const forms: ScopedDependencyV2[] = [...access.recordedForms(), { form: "owners", namespace: scope.namespace.name, entries }];
  if (scope.context === null) return forms;
  const answer = pin.context;
  forms.push({
    form: "retrieval", namespace: scope.namespace.name,
    index: answer?.index ?? { name: `namespace-keyword/${scope.namespace.name}`, root: "unavailable", labelEpoch: pin.labelEpoch },
    query: scope.context.query, k: scope.context.k, scanBudget: scope.context.scanBudget,
    results: access.context.map(({ path, digest }) => ({ path, digest })), truncated: answer?.answer.truncated ?? false,
    availability: answer?.index === null ? "index_behind" : "current", memberFence: snapshot?.memberFence ?? "members-0",
  });
  return forms;
}

/** What persistence is built from: the kept candidates with their targets, the skips, and the coverage. */
interface BoundedPlan {
  entries: { candidate: ReviewCandidate; target: PlanTarget }[];
  skipped: SkippedItem[];
  coverage: ScopedCoverageV2;
}

/** Check the plan against the scope, then floor, guard and bound the candidates and state the coverage. */
async function boundedPlan(generated: ScopedGeneration, pathOf: (candidate: ReviewCandidate) => string): Promise<BoundedPlan> {
  const { access, scope, pin } = generated;
  assertPlanInScope([...access.candidates, ...access.dropped], generated);
  const floor = await partitionByFloor(access.candidates, pathOf);
  const readable = new Set([...scope.sources.names, ...generated.closure.expanded]);
  const bounded = boundCandidates(floor.allowed, floor.skipped, scope, { pathOf, snapshot: pin.namespaces.get(scope.namespace.name), readable });
  await access.noteSourceFacts(bounded.coOwners);
  const coverage = settledCoverage(access, {
    scope, closure: generated.closure, bounded, floored: access.candidates, allowed: floor.allowed,
    pathOfSlug: (slug) => namespacedPagePath(scope.namespace.name, slug),
  });
  return { entries: await planEntriesIn(pin.view, bounded.kept, pathOf), skipped: bounded.skipped, coverage };
}

/** The dependency record, refused when it exceeds the declared bound. */
function dependenciesOf(generated: ScopedGeneration, plan: BoundedPlan, pathOf: (candidate: ReviewCandidate) => string): ScopedDependenciesV2 {
  const { access, scope } = generated;
  const guarded = [...access.candidates, ...access.dropped].map((candidate) => pathOf(candidate as ReviewCandidate));
  const forms = dependencyForms(generated, guarded);
  const targets = plan.entries.map(({ target }) => ({ path: target.path, pre: target.pre }));
  const entryCount = forms.reduce((count, form) => count + (form.form === "owners" ? form.entries.length : 1), 0);
  if (entryCount + targets.length > scope.bounds.maxDependencies) throw new PortableRefusal("limit_exceeded", "dependencies");
  return { protocol: SCOPED_PROTOCOL_V2, scopeDigest: recordDigest(scope), namespace: scope.namespace.name, forms, targets };
}

/** STEP 3 body: bound the plan, record coverage and dependencies, validate them against the current head. */
async function resolveScoped(
  store: ScopedStoreSurface, record: OperationIdentityRecordV1, generated: ScopedGeneration, fence: PolicyFence,
): Promise<ResolvedPublication> {
  const pathOf = (candidate: ReviewCandidate): string => namespacedPagePath(generated.scope.namespace.name, candidate.slug);
  const consumed: ScopedCompileAccess = generated.access;
  const plan = await boundedPlan(generated, pathOf);
  const dependencies = dependenciesOf(generated, plan, pathOf);
  const paths = scopedProposalPaths(record.operationId);
  const { writes, receipt } = buildRecordBatch({
    operationId: record.operationId, intentDigest: record.intentDigest, entries: plan.entries, skipped: plan.skipped,
    labels: normalizeLabels([generated.compartment, ...consumed.consumedLabels()]),
    dependencies: { path: paths.readSet, value: dependencies }, extra: [{ path: paths.coverage, value: plan.coverage }],
  });
  await validateScopedDependencies(store, dependencies);
  return {
    writes, tail: [], skipped: plan.skipped, onBehalfOf: [], proposal: receipt, policyFence: fence,
    consumedApprovalId: null, consumedTicketId: null,
  };
}

/**
 * The `proposal.persist` operation of a scoped protocol. Its intent digest
 * covers the protocol and the scope exactly as received, so a malformed
 * request is still a recorded outcome of its own operation id.
 */
export function scopedProposeOperation(
  runtime: ProjectRuntime, request: { operationId: string; supersedes?: string }, protocol: string, scope: unknown,
): OperationRequest {
  const supersedes = request.supersedes ?? null;
  return {
    operationId: request.operationId, kind: "proposal.persist", supersedes, requires: SCOPED_VERBS.propose,
    intentDigest: intentDigestOf(runtime.principal, "proposal.persist", request.operationId, supersedes, { protocol, scope }),
  };
}
