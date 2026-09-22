/**
 * @file src/operations-packs/runtime/materializer-obligation.ts
 * @description THE Milestone A obligation a compiled pack action's terminal
 * intent drafts are authored into (runner design v3 §5). For each draft the
 * terminal phase actually published it emits one create TARGET, one PROPOSAL
 * naming that target's logical identity, and one accept RECONCILIATION over
 * them — the exact triple `preparations/intent-compiler.ts` needs to compile a
 * REAL mutation into the handoff bundle. Emitting empty target/proposal sets, as
 * this seam previously did, produced a bundle that carried no mutation at all.
 *
 * IT IS THREE DECLARED ROWS, NOT A TRANSLATOR. The pack intent grammar names five
 * mutation kinds; this module discharges page, relation, and catalog rows and
 * refuses the remaining apply-time-only rows BY NAME. `projection-register` needs
 * the digest of output no renderer has produced as a registered projection row
 * (a RENDERED projection lands as a page create instead); `lifecycle-transition`
 * needs the page's CURRENT `pageDigest` and a post-apply `eventDigest`. Emitting
 * any of them would mean minting a digest that attests to nothing.
 *
 * `relation-upsert` IS THE SECOND ROW, and the old refusal's premise — that its
 * `postcondition.recordId` is minted by the relation store at apply time — was
 * FALSE: the relation adapter verifies by a content hash computed pre-apply and
 * echoes the postcondition digest, and `buildRelationRef` mints an id only when
 * none is SUPPLIED. So the draft's canonical relation content is the digest, and
 * the record id is DERIVED from that same hash (`rel_<contentHash-prefix>`),
 * both computed with the STORE'S OWN `relationContentHash` over exactly the
 * content shape it persists, before anything applies; the operation apply seam
 * threads the promised id into the store, which makes the postcondition TRUE
 * rather than attested. The promise binds records this mutation CREATES: a
 * same-content dedupe keeps the pre-existing record's own id, and the skip
 * outcome names it. The draft convention is closed: `relationType`, `from`, and `to` are
 * required text fields, and every OTHER draft field is a relation attribute. A
 * relation target declares a dependency on any page target in the SAME
 * obligation whose entity identity its endpoints name, and pages are ordered
 * before relations, so the manifest-order protocol applies endpoints first.
 *
 * THE FIRST ROW IS `artifact-upsert` → a Milestone A `page` CREATE,
 * and that substitution is deliberate rather than incidental. Milestone A's own
 * `artifact` create is NOT authorable here either — its postcondition requires
 * `manifestDigest` and `auditDigest`, both written by the artifact store at apply
 * time and read by nothing that could derive them — while `page` create is the
 * one Milestone A create whose ENTIRE postcondition is the payload's own content
 * address. The vertical's recipe declares `targetProfileClass: "wiki-page"`, so
 * the page store is the writer that owns what the draft describes; the emitted
 * target names the profile class as its entity type and the draft's own source
 * item as its slug, and both are re-checked against the repository's slug-safe
 * identity floor before they can reach a target.
 *
 * NOTHING IS FABRICATED, AND THE PAYLOAD AUTHENTICATES ITSELF. The payload bytes
 * are the draft's OWN published payload — the canonical bytes of exactly the
 * record `handlers/intent-compile.ts` digested into `payloadDigest` — and this
 * module RECOMPUTES that digest and refuses a draft whose published digest does
 * not bind its own published fields. `postcondition` is that payload's content
 * address and byte count: the bytes the page would hold, never a post-apply
 * observation. `precondition` is `absent`, so a target that already exists fails
 * closed at apply rather than being overwritten by a proposal that never looked.
 */

import { createHash } from "node:crypto";
import { canonicalBytes } from "../../profile/templates/signing/canonical.js";
import { isSlugSafe } from "../../profile/identity.js";
import type { EntityId } from "../../profile/types.js";
import { relationContentHash } from "../../relations/digest.js";
import { draftPayloadBytes } from "../handlers/page-payload.js";
import type { AttemptId } from "../../preparations/ids.js";
import type { HostMutationTargetV1 } from "../../preparations/intent-compiler.js";
import type { PageOperationMutation } from "../../operation-bundles/types.js";
import type { MaterializedPayloadRefV1 } from "../../preparations/materialization.js";
import { normalizeProviderProposals, type PreparationProposalV1 } from "../../preparations/proposals.js";
import { decideReconciliation, type PreparationReconciliationV1 } from "../../preparations/reconciliation.js";
import type { PreparationPolicyContractV1 } from "../../preparations/selection.js";
import type { EvidenceRefV1, Sha256Digest } from "../../preparations/types.js";
import type { PackIntentDraftV1 } from "../handlers/types.js";
import { PackMaterializationError } from "../problems.js";

/** The pack intent mutation kind discharged as a Milestone A page create. */
const PAGE_PACK_MUTATION_KIND = "artifact-upsert";

/** The pack intent mutation kind discharged as a Milestone A relation create. */
const RELATION_PACK_MUTATION_KIND = "relation-upsert";

/**
 * The required text fields of one relation draft; every other field is an
 * attribute. SLUG-SAFE deliberately: a parsed pack's targetField grammar admits
 * lowercase slugs only, so the structural keys must be expressible there — the
 * camelCase member names live on the mutation, not the draft.
 */
const RELATION_STRUCTURAL_FIELDS = Object.freeze(["relation-type", "from", "to"] as const);

/** The hex-prefix length of a derived relation record id (`rel_<prefix>`). */
const RELATION_ID_PREFIX_HEX = 16;

/**
 * The post-apply field that refuses every OTHER pack intent kind. The table is
 * the refusal's reason, so the gap is reported rather than silently narrowed.
 */
const CATALOG_PACK_MUTATION_KIND = "catalog-append";

const UNSOURCEABLE_BY_KIND: ReadonlyMap<string, string> = new Map([
  ["projection-register", "projection postcondition.digest is the digest of output no renderer has produced"],
  ["lifecycle-transition", "lifecycle precondition.pageDigest and postcondition.eventDigest are apply-time state"],
]);

/** The payload role and media type of one draft's own canonical published bytes. */
const TARGET_PAYLOAD_ROLE = "target-payload";
const CANONICAL_JSON_MEDIA_TYPE = "application/json";

/** The fixed identity of the single accept decision this obligation carries. */
const ACCEPT_RECONCILIATION_ID = "pack-intent-accept";

/**
 * The reason the accept carries. This vertical's recipe declares NO reconcile
 * phase, so no store snapshot was compared and no authority to compare one was
 * available — `absent` would assert an observation this module never made. The
 * mutation's own `precondition: { kind: "absent" }` carries that check to apply
 * time, where the page adapter actually looks.
 */
const ACCEPT_REASON_CODE = "unavailable-authority";

/** Everything one obligation is authored from; every field is durable-sourced. */
export interface PackObligationInputV1 {
  /** The registered policy contract the proposals and the accept are closed to. */
  readonly contract: PreparationPolicyContractV1;
  /** The drafts the terminal intent phase actually published. */
  readonly drafts: readonly PackIntentDraftV1[];
  /** The run's own evidence reference for those drafts. */
  readonly evidenceRef: EvidenceRefV1;
  /** The attempt the durable phase summary records as having produced them. */
  readonly attemptId: AttemptId;
  /** The producing host-handler family's plan-pinned contract identity. */
  readonly producerContractDigest: Sha256Digest;
}

/** The complete obligation one terminal draft set compiles to. */
export interface PackObligationV1 {
  readonly targets: readonly HostMutationTargetV1[];
  readonly proposals: readonly PreparationProposalV1[];
  readonly reconciliations: readonly PreparationReconciliationV1[];
  readonly payloadRefs: readonly MaterializedPayloadRefV1[];
  readonly payloads: ReadonlyMap<string, Buffer>;
  /** The source item identities that actually produced a draft. */
  readonly completedIdentities: readonly string[];
}

/**
 * One draft resolved to its target and its identity. Only a PAGE row carries a
 * payload: a relation mutation's content travels inline on the mutation itself
 * (the manifest grammar admits no relation payload bytes), so relation rows
 * contribute nothing to the bundle's payload set.
 */
interface AuthoredTargetV1 {
  readonly target: HostMutationTargetV1;
  readonly logicalIdentity: string;
  readonly sourceItemId: string;
  readonly payload?: { readonly bytes: Buffer; readonly hex: string };
}

/** Refuse any pack intent kind whose Milestone A create cannot be sourced. */
function assertSupportedKind(kind: string): void {
  if (kind === PAGE_PACK_MUTATION_KIND || kind === RELATION_PACK_MUTATION_KIND
    || kind === CATALOG_PACK_MUTATION_KIND) return;
  if (kind === PAGE_UPDATE_PACK_MUTATION_KIND || kind === PAGE_DELETE_PACK_MUTATION_KIND) return;
  const unsourceable = UNSOURCEABLE_BY_KIND.get(kind);
  if (unsourceable === undefined) {
    throw new PackMaterializationError("an intent draft declares an unregistered mutation kind");
  }
  throw new PackMaterializationError(`this mutation kind cannot be authored: ${unsourceable}`);
}

/**
 * Rebuild the draft's OWN published payload and prove it. A page draft's
 * payload is the FORMATTED PAGE — frontmatter plus body through the ONE shared
 * {@link formatPageBytes} — which is what `intent-compile` digested into
 * `payloadDigest`, so the recomputed digest equaling the published digest is
 * what makes these bytes the draft's payload rather than bytes this module
 * chose to call one. The store writes exactly these bytes, so the page the
 * profile collector reads back is a page it can parse — a raw canonical record
 * here would poison the store against the NEXT run's reconcile snapshot.
 */
function draftPayload(draft: PackIntentDraftV1): { bytes: Buffer; hex: string } {
  const bytes = draftPayloadBytes({
    mutationKind: draft.mutationKind, targetProfileClass: draft.targetProfileClass,
    fields: draft.fields, ...(draft.listFields === undefined ? {} : { listFields: draft.listFields }),
  });
  const hex = createHash("sha256").update(bytes).digest("hex");
  if (`sha256:${hex}` !== draft.payloadDigest) {
    throw new PackMaterializationError("an intent draft's payload digest does not bind its own published fields");
  }
  return { bytes, hex };
}

/** The slug-safe entity identity one draft names; a non-slug value fails closed. */
function targetIdentity(draft: PackIntentDraftV1): { entityType: string; slug: string } {
  if (!isSlugSafe(draft.targetProfileClass) || !isSlugSafe(draft.sourceItemId)) {
    throw new PackMaterializationError("an intent draft does not name a slug-safe page identity");
  }
  return { entityType: draft.targetProfileClass, slug: draft.sourceItemId };
}

/** The pack intent kind that REPLACES an existing page rather than creating one. */
const PAGE_UPDATE_PACK_MUTATION_KIND = "artifact-update";

/** The pack intent kind that REMOVES an existing page. */
const PAGE_DELETE_PACK_MUTATION_KIND = "artifact-delete";

/**
 * The precondition one page draft is applied under.
 *
 * A CREATE expects nothing to be there. An UPDATE expects EXACTLY the bytes it
 * was computed against, so the executor conflicts — and parks — if the page
 * changed between proposal and apply. Authoring an update with an absent or
 * unconstrained precondition would turn a reviewed edit into a blind
 * overwrite of whatever the page had become.
 */
function pagePrecondition(draft: PackIntentDraftV1): PageOperationMutation["precondition"] {
  const destructive = draft.mutationKind === PAGE_UPDATE_PACK_MUTATION_KIND
    || draft.mutationKind === PAGE_DELETE_PACK_MUTATION_KIND;
  if (!destructive) return { kind: "absent" };
  const expected = draft.expectedCurrent;
  if (expected === undefined) {
    throw new PackMaterializationError("a destructive page draft carries no precondition to apply under");
  }
  // A page precondition is a DIGEST state ({kind, digest}); the expected byte
  // count rides the POSTcondition, not here. Typed against the mutation's own
  // precondition so the manifest parser and this authoring can never drift.
  return { kind: "digest", digest: `sha256:${expected.digest}` };
}

/** Author one complete `page` create-or-update target from one authenticated draft. */
function authorPageTarget(draft: PackIntentDraftV1): AuthoredTargetV1 {
  const payload = draftPayload(draft);
  const { entityType, slug } = targetIdentity(draft);
  const logicalIdentity = `entity:${entityType}:${slug}`;
  const deleting = draft.mutationKind === PAGE_DELETE_PACK_MUTATION_KIND;
  const update = draft.mutationKind === PAGE_UPDATE_PACK_MUTATION_KIND;
  return {
    logicalIdentity, sourceItemId: draft.sourceItemId, payload,
    target: {
      logicalIdentity,
      draft: {
        kind: "page", operation: deleting ? "delete" : update ? "update" : "create",
        target: { kind: "entity", entityType, slug },
        payloadRef: payload.hex, precondition: pagePrecondition(draft),
        // A DELETE declares absence: it produces no bytes, so it cannot claim a
        // resulting digest without attesting to something that will not exist.
        postcondition: deleting
          ? { kind: "absent" as const }
          : { digest: `sha256:${payload.hex}`, byteCount: payload.bytes.byteLength },
      },
    } as unknown as HostMutationTargetV1,
  };
}

/** Author a catalog append whose physical record id is stamped at bundle creation. */
function authorCatalogTarget(draft: PackIntentDraftV1): AuthoredTargetV1 {
  const payload = draftPayload(draft);
  if (!isSlugSafe(draft.sourceItemId)) {
    throw new PackMaterializationError("a catalog draft does not name a slug-safe logical record id");
  }
  const logicalIdentity = `catalog:${draft.sourceItemId}`;
  return {
    logicalIdentity, sourceItemId: draft.sourceItemId, payload,
    target: {
      logicalIdentity,
      draft: {
        kind: "catalog-record", operation: "create",
        target: { logicalRecordId: draft.sourceItemId }, payloadRef: payload.hex,
        precondition: { kind: "absent" }, postcondition: { digest: `sha256:${payload.hex}` },
      },
    } as unknown as HostMutationTargetV1,
  };
}

/** The closed relation content one draft declares: structure plus attributes. */
interface RelationDraftContentV1 {
  readonly relationType: string;
  readonly from: string;
  readonly to: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Read the closed relation convention off one draft's fields: the three
 * structural members are required non-empty text, and every OTHER field is a
 * relation attribute. A draft missing a structural member refuses by the
 * existing draft-validation discipline rather than authoring a partial edge.
 */
function relationContent(draft: PackIntentDraftV1): RelationDraftContentV1 {
  const structural: Record<string, string> = {};
  for (const member of RELATION_STRUCTURAL_FIELDS) {
    const value = draft.fields[member];
    if (typeof value !== "string" || value.length === 0) {
      throw new PackMaterializationError(`a relation draft is missing its required ${member} field`);
    }
    structural[member] = value;
  }
  const attributes: Record<string, string | number | boolean> = {};
  for (const [fieldId, value] of Object.entries(draft.fields)) {
    if (!(RELATION_STRUCTURAL_FIELDS as readonly string[]).includes(fieldId)) attributes[fieldId] = value;
  }
  return {
    relationType: structural["relation-type"]!, from: structural.from!, to: structural.to!, attributes,
  };
}

/**
 * Author one complete `relation` create target from one authenticated draft.
 *
 * BOTH POSTCONDITION MEMBERS ARE PRE-APPLY FACTS COMPUTED WITH THE STORE'S OWN
 * PRIMITIVE: the digest is `relationContentHash` over exactly the content shape
 * the relation store persists (`{type, from, to, attributes, evidence}`), and
 * the record id is DERIVED from that same hash (`rel_<hex-prefix>`) — so the
 * digest the manifest attests IS the contentHash the store writes, and the id
 * the manifest promises is the id the apply seam threads in. A second shape
 * here would attest a quantity the store never persists. Endpoints are hashed
 * AS DECLARED: canonical order is a profile fact (symmetric relations sort),
 * which this profile-less seam cannot know, so the adapter re-derives the
 * canonical hash at apply and CONFLICTS on divergence rather than letting a
 * non-canonical declaration verify a false digest. The mutation carries its
 * content inline; there is no relation payload.
 */
function authorRelationTarget(draft: PackIntentDraftV1): AuthoredTargetV1 {
  draftPayload(draft); // authenticate the draft's own published digest
  const content = relationContent(draft);
  const hex = relationContentHash({
    type: content.relationType, from: content.from as EntityId, to: content.to as EntityId,
    attributes: content.attributes, evidence: undefined,
  });
  // The proposal identity grammar admits no `/`; endpoints are exactly
  // `type/slug`, so `:`-encoding keeps a fixed, unambiguous segment arity.
  const logicalIdentity =
    `relation:${content.relationType}:${content.from.replace("/", ":")}:${content.to.replace("/", ":")}`;
  return {
    logicalIdentity, sourceItemId: draft.sourceItemId,
    target: {
      logicalIdentity,
      draft: {
        kind: "relation", operation: "create",
        target: { relationType: content.relationType, from: content.from, to: content.to },
        attributes: content.attributes, precondition: { kind: "absent" },
        postcondition: { digest: `sha256:${hex}`, recordId: `rel_${hex.slice(0, RELATION_ID_PREFIX_HEX)}` },
      },
    } as HostMutationTargetV1,
  };
}

/** The page logical identity one relation endpoint (`type/slug`) names, if any. */
function endpointIdentity(endpoint: string): string | null {
  const [entityType, slug, extra] = endpoint.split("/");
  if (entityType === undefined || slug === undefined || extra !== undefined) return null;
  return `entity:${entityType}:${slug}`;
}

/**
 * Author every draft, PAGES FIRST, and give each relation target a declared
 * dependency on any page target in the same obligation its endpoints name. The
 * intent compiler refuses forward dependencies, so this ordering is what makes
 * a same-bundle page-then-relation pair compilable at all — and the manifest
 * order protocol then applies endpoints before the edges that reference them.
 * Drafts and authored rows stay index-aligned for the proposal author.
 */
function authorOrderedTargets(
  drafts: readonly PackIntentDraftV1[],
): { authored: AuthoredTargetV1[]; ordered: PackIntentDraftV1[] } {
  for (const draft of drafts) assertSupportedKind(draft.mutationKind);
  // BOTH page kinds author through the same path: a relation depending on a
  // page must find it whether that page is being created or replaced.
  const pages = drafts.filter((draft) => draft.mutationKind === PAGE_PACK_MUTATION_KIND
    || draft.mutationKind === PAGE_UPDATE_PACK_MUTATION_KIND
    || draft.mutationKind === PAGE_DELETE_PACK_MUTATION_KIND);
  const catalogs = drafts.filter((draft) => draft.mutationKind === CATALOG_PACK_MUTATION_KIND);
  const relations = drafts.filter((draft) => draft.mutationKind === RELATION_PACK_MUTATION_KIND);
  const authoredPages = pages.map(authorPageTarget);
  const authoredCatalogs = catalogs.map(authorCatalogTarget);
  const pageIdentities = new Set(authoredPages.map((entry) => entry.logicalIdentity));
  const authoredRelations = relations.map((draft) => {
    const authored = authorRelationTarget(draft);
    const mutation = authored.target.draft as { target: { from: string; to: string } };
    const dependsOn = [mutation.target.from, mutation.target.to]
      .map(endpointIdentity)
      .filter((identity): identity is string => identity !== null && pageIdentities.has(identity));
    if (dependsOn.length === 0) return authored;
    return {
      ...authored,
      target: { ...authored.target, dependsOnLogicalIdentities: [...new Set(dependsOn)] },
    };
  });
  return {
    authored: [...authoredPages, ...authoredCatalogs, ...authoredRelations],
    ordered: [...pages, ...catalogs, ...relations],
  };
}

/**
 * Normalize one proposal per authored target. The proposal kind is the pack's
 * own target profile class, which is the ONE kind
 * `runtime/policy-contract.ts` admits, and the proposed value is the draft's
 * resolved fields — what the run actually proposes about that identity.
 */
function authorProposals(
  authored: readonly AuthoredTargetV1[], drafts: readonly PackIntentDraftV1[],
  input: PackObligationInputV1,
): readonly PreparationProposalV1[] {
  return normalizeProviderProposals({
    contract: input.contract, attemptId: input.attemptId,
    // A host-handler family has no provider pin; its pinned producing identity is
    // the plan-pinned handler contract, which is what this provenance attests to.
    providerPinDigest: input.producerContractDigest,
    sourceEvidenceRefs: [input.evidenceRef],
    drafts: authored.map((entry, index) => ({
      proposalKind: drafts[index]!.targetProfileClass,
      targetLogicalIdentity: entry.logicalIdentity,
      proposedValue: drafts[index]!.fields,
    })),
  });
}

/** One deduplicated payload ref per distinct authored PAGE payload address. */
function payloadRefsFor(authored: readonly AuthoredTargetV1[]): readonly MaterializedPayloadRefV1[] {
  const byDigest = new Map<string, MaterializedPayloadRefV1>();
  for (const entry of authored) {
    if (entry.payload === undefined) continue;
    byDigest.set(entry.payload.hex, {
      role: TARGET_PAYLOAD_ROLE, digest: entry.payload.hex,
      byteCount: entry.payload.bytes.byteLength, mediaType: CANONICAL_JSON_MEDIA_TYPE,
    });
  }
  return [...byDigest.values()];
}

/**
 * Author the complete obligation for one terminal draft set.
 *
 * @param input - The registered contract, the published drafts, the run's own
 *   evidence reference for them, the producing attempt, and the plan-pinned
 *   producing contract identity.
 * @returns The targets, proposals, accept reconciliation, payload references and
 *   payload bytes one Milestone A bundle needs to carry a real mutation.
 * @throws PackMaterializationError when a draft names an unsourceable mutation
 *   kind, publishes a payload digest that does not bind its own fields, or does
 *   not name a slug-safe page identity.
 */
export function authorPackObligation(input: PackObligationInputV1): PackObligationV1 {
  const { authored, ordered } = authorOrderedTargets(input.drafts);
  const proposals = authorProposals(authored, ordered, input);
  const reconciliations = [decideReconciliation({
    reconciliationId: ACCEPT_RECONCILIATION_ID, contract: input.contract, proposals,
    proposalIds: proposals.map((proposal) => proposal.proposalId), decision: "accept",
    reasonCodes: [ACCEPT_REASON_CODE], evidenceRefs: [input.evidenceRef],
  })];
  const payloadEntries = authored.flatMap((entry) =>
    entry.payload === undefined ? [] : [[entry.payload.hex, entry.payload.bytes] as const]);
  return {
    targets: authored.map((entry) => entry.target), proposals, reconciliations,
    payloadRefs: payloadRefsFor(authored),
    payloads: new Map(payloadEntries),
    // One identity is one completed item however many rows it authored — a page
    // and its relations legitimately share a source item.
    completedIdentities: [...new Set(authored.map((entry) => entry.sourceItemId))],
  };
}
