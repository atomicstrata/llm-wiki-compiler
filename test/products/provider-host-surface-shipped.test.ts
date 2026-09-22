/**
 * @file test/products/provider-host-surface-shipped.test.ts
 * @description The COMPLETE public runtime export surface of the distributed
 * artifact, pinned name and KIND, name by name.
 *
 * A DOCUMENTED ROUTE THAT ONLY WORKS IN A CHECKOUT IS NOT A ROUTE. Every test in
 * this repository imports repository source, so nothing noticed when the
 * provider-hosting documentation told operators to import a PRIVATE workspace
 * package that `npm pack` never contained — following the instructions produced
 * ERR_MODULE_NOT_FOUND while the suite stayed green. This reads `dist/`, which
 * is what an installed operator actually reaches.
 *
 * IT IS AN ALLOWLIST, NOT A SPOT CHECK, AND THAT APPLIES TO KIND AS WELL AS TO
 * NAME. Two earlier versions named a handful of exports: first a presence check
 * over five constructors, then a callability check over the same five. Both
 * refuse only the cases someone thought to enumerate — the second passed while
 * `devGrantScope` was replaced by a non-callable constant, because that name was
 * not one of the five. Pinning every export's NAME and its runtime KIND closes
 * the class instead of the two instances: an export added, removed, or changed
 * from a function to a value fails here, so altering the public surface has to
 * be a decision recorded in this table rather than a side effect of an edit
 * somewhere else.
 *
 * RUNTIME EXPORTS ONLY, and that is a deliberate boundary rather than an
 * oversight. Types erase at build, so `dist/index.js` carries exactly what an
 * operator can call; the `.d.ts` surface is far larger and changes with every
 * legitimate type addition, so pinning it would produce a control that fails
 * constantly and gets suppressed. What breaks an operator's import is a missing
 * or uncallable VALUE, which is what this pins.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIST = path.resolve("dist/index.js");

/**
 * Every value `llmwiki` exports, with the `typeof` an operator gets, sorted.
 *
 * Editing a line here is a public API change. The provider-hosting constructors
 * are in this table because an operator's provider module can only import what
 * the published package exports, and can only USE what it exports as a function
 * — that pair is the whole reason this file exists.
 */
const PUBLIC_RUNTIME_EXPORTS: Readonly<Record<string, string>> = {
  ArtifactVerifyUnavailableError: "function",
  // D-ENSURE-CODE (P6.3d): a companion publishes an experiment program with the SAME
  // create-only, durable, confined write the platform uses — the primitive and its two
  // typed refusals are public so the companion never hand-rolls a weaker one.
  AtomicWriteCollisionError: "function",
  AtomicWriteCommittedCleanupError: "function",
  atomicWrite: "function",
  // D-BACKEND-PACKAGING (P6.3d): a packaged backend launches a provider through the
  // platform's own entrypoint resolution and launch environment.
  providerLaunchEnv: "function",
  resolveProviderEntrypoint: "function",
  // D-DEMO-HOST v3 (P6.3d): a provider install verifies the expanded tree digest with
  // the platform's canonical encoding, so the payload builder outside the checkout
  // computes the SAME digest the installer checks.
  canonicalBytes: "function",
  canonicalDigest: "function",
  DEV_PROVIDER_BOUNDS: "object",
  // The out-of-band trusted-write grant predicate a coordinator asserts at
  // start-time (P6.3c) — the SAME primitive the artifact executor gates on.
  isTrustedWriteGranted: "function",
  // The generic confined capped reader a coordinator re-reads retained evidence
  // through (P6.3c) — the SAME confinement proof the page/artifact readers use.
  readConfinedCappedBuffer: "function",
  // The authenticated operation-bundle applied-state observation a coordinator
  // binds to the exact bundle digest (P6.3c-2b) before recording a stage checkpoint.
  observeOperationBundle: "function",
  LifecycleTransitionError: "function",
  LifecycleTransitionUnavailableError: "function",
  LockUnavailableError: "function",
  PrincipalAuthorityError: "function",
  ProviderUnavailableError: "function",
  QueueFullError: "function",
  RelationEndpointError: "function",
  RelationWriteDeniedError: "function",
  RelationsRequireProfileError: "function",
  StagingRequiresProfileError: "function",
  UnknownProviderError: "function",
  // Product workflow drivers bind the installed process definition and explicit
  // workspace at creation, then enforce that same authority on later commands.
  WorkflowProcessAuthorityError: "function",
  WorkflowRefusalError: "function",
  HumanInputValidationError: "function",
  HOST_DECLARED_CONTRACT_SET: "object",
  acquireMutationLockBlocking: "function",
  approveHumanGateInteractively: "function",
  artifactPaths: "function",
  assertCurrentWorkflowProcessAuthority: "function",
  assertProductDigest: "function",
  assertProductOperationOutputCurrent: "function",
  assertProductStageOutputCurrent: "function",
  assertRunOwnership: "function",
  assertRunWorkspace: "function",
  captureVerifiedMemberArtifact: "function",
  refuseWorkflow: "function",
  startProductWorkflow: "function",
  // The viewer's bare-slug resolution pair, exported so a product package's
  // citation renderer applies the viewer's OWN semantics (slugified target →
  // concept/query precedence → alias fallback) rather than approximating them.
  collectViewerPages: "function",
  confineUnderRoot: "function",
  createVerifierRegistry: "function",
  currentActorIdentity: "function",
  defaultHostCompatibility: "function",
  formatArtifactRef: "function",
  isSlugSafe: "function",
  loadNonDefaultProfile: "function",
  loadProfile: "function",
  memberLeafPath: "function",
  mintVerifierReceipt: "function",
  parseArtifactRef: "function",
  parseOperationsPack: "function",
  predecessorChainRoot: "function",
  readArtifactMemberBytes: "function",
  readLiveTargetDigest: "function",
  readRun: "function",
  readVerifiedArtifactBody: "function",
  recomputeCompositionLock: "function",
  recomputePackageDigest: "function",
  recomputeRuntimeAuthorityDigest: "function",
  releaseLock: "function",
  resolveArtifactRef: "function",
  resolveConfinedPrivateDir: "function",
  resolveCurrentStage: "function",
  resolveGateChallenge: "function",
  // The generic public viewer constructor (P9.1) — owns snapshot construction so a
  // product operator entry starts the viewer with an injected live projection provider
  // WITHOUT deep-importing snapshot building. Generic: no product vocabulary in core.
  startViewer: "function",
  startWorkflowLocked: "function",
  transitionLifecycle: "function",
  verifierImplementationDigest: "function",
  // The generic active-profile digest observation (P9.2) — a product operator entry binds
  // its live verified-stage projection to the SAME profile digest core computes, without
  // importing the internal profile loader. Generic: reads whatever profile is installed.
  activeProfileDigest: "function",
  // The generic confined byte-fetch primitive, exported so a product package's
  // acquisition adapter (P8a arXiv) reaches the network through ONE pinned,
  // SSRF-confined, byte-capped seam rather than dialing sockets itself.
  confinedFetch: "function",
  confinedFetchRequest: "function",
  createWiki: "function",
  derivePinForPayload: "function",
  ensureConfinedDirectory: "function",
  devEffectiveGrantRequest: "function",
  devGrantScope: "function",
  devModelInvokeAuthority: "function",
  devProviderInvocation: "function",
  devSourceReadAuthority: "function",
  hostModelQuoteDigest: "function",
  installDevProvider: "function",
  issueDevProviderGrant: "function",
  // READ-ONLY durable-run observation for product-package SDK helpers (AS-3 P3):
  // locate/enumerate run manifests, read a sealed input / one evidence leaf /
  // an authenticated record, classify a recorded execution owner's liveness.
  // No run writer is exported — a package observes runs.
  classifyExecutionOwnerLiveness: "function",
  locatePreparationManifest: "function",
  // The non-scanning run read layered on an already-located manifest (P6.3c-2c(2b)):
  // a durability-repair coordinator observes the crashed run's inventory ONCE.
  readPreparationRunForManifest: "function",
  parseFrontmatter: "function",
  // The preparation manifest's self-excluded content digest — a coordinator (P6.3c)
  // authenticates a located manifest against a run's authenticated manifestDigest.
  preparationManifestDigest: "function",
  readPreparationEvidenceBytes: "function",
  readPreparationInitialInput: "function",
  resolveAuthorizedProviderPaths: "function",
  resolveBareSlug: "function",
  resolvePreparationRun: "function",
  runPreparation: "function",
  scanPreparationInventory: "function",
  scaffoldConfinedDirectories: "function",
  slugify: "function",
};

/** The built artifact's exports, as a name-to-kind table. */
async function shippedExports(): Promise<Record<string, string>> {
  // `npm run build` is a gate step, so a missing artifact means the suite ran
  // out of order rather than that an export is absent.
  expect(existsSync(DIST), "dist/index.js is missing; run npm run build").toBe(true);
  const shipped = await import(DIST) as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(shipped).sort().map((name) => [name, typeof shipped[name]]),
  );
}

describe("the distributed artifact's public surface", () => {
  it("exports EXACTLY the pinned names, each with its pinned kind", async () => {
    // One assertion covers both directions: a missing or extra key fails, and so
    // does a name that survives as the wrong kind — a function demoted to a
    // constant, or a type-only re-export that leaves an operator's call broken.
    expect(await shippedExports()).toEqual(PUBLIC_RUNTIME_EXPORTS);
  });

  it("ships NO provider backend implementation", async () => {
    // The contract is a type and erases at build; an exported CONSTRUCTOR would
    // mean the published package launches providers, which is the decision this
    // design leaves to the operator. This does NOT detect a backend under an
    // unrelated name — the pinned table above is what refuses additions. It
    // states the intent for whoever edits that table.
    const backendish = Object.keys(PUBLIC_RUNTIME_EXPORTS).filter((n) => /backend/i.test(n));
    expect(backendish).toEqual([]);
  });
});
