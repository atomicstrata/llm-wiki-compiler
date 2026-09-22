/**
 * @file src/operations-packs/handlers/registry.ts
 * @description The generic host-handler registry (design section 16.1). It
 * compiles the CLOSED taxonomy of six registered handler families into descriptors
 * the attempt boundary consumes ({@link ../../preparations/attempts/types}), each
 * declaring its family, contract version, effect class, determinism, read-only and
 * idempotency properties, resource bounds, and a computed contract DIGEST over the
 * full closed contract. {@link createHostHandlerRegistry} returns a
 * {@link PreparationHostHandlerRegistryV1} whose `resolve` fails closed on an
 * unknown handler id, a drifted contract digest, or a wrong contract version — the
 * exact drift the sealed attempt revalidates against.
 *
 * PURE LAYER BOUNDARY. This slice delivers the descriptors and the six PURE family
 * compute functions (this module's siblings); the `PreparationHostHandlerV1.execute`
 * runtime — which locates the sealed input evidence by exposure digest and
 * publishes output bytes into temporary custody — is a later WOP slice. Because a
 * pure family cannot materialize on-disk evidence and `resolve(ref)` receives no
 * phase body or evidence, the resolved handler fails closed with the fixed
 * `host-handler-runtime-unavailable` problem until that runtime binds it. No handler
 * here writes.
 */

import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import { assertPackDigest } from "../ids.js";
import { PackHostHandlerError } from "./types.js";
import type {
  HostHandlerDescriptorV1, HostHandlerRefV1, HostHandlerResolutionV1,
  HostHandlerResultV1, PreparationHostHandlerRegistryV1, PreparationHostHandlerV1,
} from "../../preparations/attempts/types.js";

const CONTRACT_VERSION = "1.0.0";
const MAX_HANDLER_OUTPUT_BYTES = 262_144;
const MAX_HANDLER_WALL_TIME_MS = 5_000;

/**
 * The full closed contract of one registered family; every field is folded into
 * the contract DIGEST, so a change to any property — bounds, effect class,
 * schema, ordering, read-only, or idempotency — drifts the digest and fails closed.
 */
interface HandlerContractV1 {
  readonly handlerId: string;
  readonly handlerContractVersion: string;
  readonly effectClass: HostHandlerDescriptorV1["effectClass"];
  readonly deterministic: boolean;
  readonly readOnly: boolean;
  readonly idempotent: boolean;
  readonly recovery: HostHandlerDescriptorV1["recovery"];
  readonly maximumOutputBytes: number;
  readonly maximumWallTimeMs: number;
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly ordering: string;
}

/** Build one closed family contract; all six are read-only, pure/deterministic. */
function contract(handlerId: string, effectClass: HostHandlerDescriptorV1["effectClass"], inputSchema: string, outputSchema: string, ordering: string): HandlerContractV1 {
  return {
    handlerId, handlerContractVersion: CONTRACT_VERSION, effectClass,
    deterministic: true, readOnly: true, idempotent: true, recovery: "restart-safe",
    maximumOutputBytes: MAX_HANDLER_OUTPUT_BYTES, maximumWallTimeMs: MAX_HANDLER_WALL_TIME_MS,
    inputSchema, outputSchema, ordering,
  };
}

/** The closed taxonomy of six registered host-handler families (section 16.2-16.7). */
const HANDLER_CONTRACTS: readonly HandlerContractV1[] = [
  contract("context-assemble", "reads-project", "PackContextInputV1", "PackContextResultV1", "declared-tier-rank-then-item-id"),
  contract("set-select", "pure", "PackSelectInputV1", "PackSelectResultV1", "stable-by-declared-fields"),
  contract("rule-evaluate", "pure", "PackRuleInputV1", "PackRuleResultV1", "rule-id-then-item-id-then-code"),
  contract("render-template", "pure", "PackRenderInputV1", "PackRenderResultV1", "template-node-order"),
  contract("reconcile", "reads-project", "PackReconcileInputV1", "PackReconcileResultV1", "identity-then-finding-class"),
  contract("intent-compile", "reads-project", "PackIntentInputV1", "PackIntentResultV1", "source-item-id"),
];

/** Project one closed contract into the attempt-boundary descriptor with its digest. */
function toDescriptor(source: HandlerContractV1): HostHandlerDescriptorV1 {
  return {
    handlerId: source.handlerId, handlerContractVersion: source.handlerContractVersion,
    handlerContractDigest: assertPackDigest(canonicalDigest(source)),
    effectClass: source.effectClass, deterministic: source.deterministic,
    maximumOutputBytes: source.maximumOutputBytes, maximumWallTimeMs: source.maximumWallTimeMs,
    recovery: source.recovery,
  };
}

/** The resolved descriptors keyed by handler id, computed once at module load. */
const DESCRIPTORS: ReadonlyMap<string, HostHandlerDescriptorV1> = new Map(
  HANDLER_CONTRACTS.map((source) => [source.handlerId, toDescriptor(source)]),
);

/**
 * The pending-runtime handler shared by every resolution (see the file header).
 * It never writes and never fabricates evidence: until a later WOP slice binds the
 * sealed phase body and input evidence, execution fails closed with a fixed problem.
 */
const PENDING_RUNTIME_HANDLER: PreparationHostHandlerV1 = Object.freeze({
  execute(): Promise<HostHandlerResultV1> {
    return Promise.resolve({
      kind: "failed", problem: "host-handler-runtime-unavailable",
      detail: "the pure host-handler layer requires the WOP runtime to bind the sealed phase body and input evidence",
    });
  },
});

/** Fail closed unless the ref binds a registered family at its exact version+digest. */
function resolve(ref: HostHandlerRefV1): HostHandlerResolutionV1 {
  const descriptor = DESCRIPTORS.get(ref.handlerId);
  if (descriptor === undefined) throw new PackHostHandlerError(`host handler is not registered: ${ref.handlerId}`);
  if (descriptor.handlerContractVersion !== ref.handlerContractVersion) {
    throw new PackHostHandlerError(`host handler contract version drift for ${ref.handlerId}`);
  }
  if (descriptor.handlerContractDigest !== ref.handlerContractDigest) {
    throw new PackHostHandlerError(`host handler contract digest drift for ${ref.handlerId}`);
  }
  return { descriptor, handler: PENDING_RUNTIME_HANDLER };
}

/** The registered handler ids in taxonomy order, for enumeration and sealing. */
export const HOST_HANDLER_FAMILY_IDS: readonly string[] = HANDLER_CONTRACTS.map((source) => source.handlerId);

/**
 * Build the generic host-handler registry (section 16.1). Its `resolve` binds a
 * sealed handler ref to the exact registered descriptor and fails closed on any
 * unknown id, version drift, or contract-digest drift.
 */
export function createHostHandlerRegistry(): PreparationHostHandlerRegistryV1 {
  return { resolve };
}

/** The exact sealed ref for one registered family, for the compiler and tests. */
export function hostHandlerRefFor(handlerId: string): HostHandlerRefV1 {
  const descriptor = DESCRIPTORS.get(handlerId);
  if (descriptor === undefined) throw new PackHostHandlerError(`host handler is not registered: ${handlerId}`);
  return {
    handlerId, handlerContractVersion: descriptor.handlerContractVersion,
    handlerContractDigest: descriptor.handlerContractDigest,
  };
}
