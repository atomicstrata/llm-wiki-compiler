/**
 * @file src/capability-providers/host/invocation.ts
 * @description The host adapter: turning a pack's SEALED provider phase into a
 * concrete provider invocation.
 *
 * THIS IS THE PIECE THE PLATFORM DELIBERATELY DOES NOT OWN. The pack runtime
 * routes a provider phase to whatever invocation its host supplies; assembling
 * that invocation means knowing which provider is installed, which grant it runs
 * under, and which backend launches it — all host facts. This module is a
 * complete worked example of that integration, for local development.
 *
 * IT BINDS THE SEAL RATHER THAN RESTATING IT. Every identity in the request is
 * taken from the phase's own sealed executor or from the install record it
 * names — never from a constant here. The provider leg re-checks all of it and
 * refuses a mismatch, so an adapter that invented an identity would fail closed;
 * deriving it means the adapter and the seal cannot disagree in the first place.
 *
 * IT REFUSES A PHASE IT CANNOT SERVE, rather than substituting the provider it
 * happens to have. Returning null declines exactly one phase and settles it
 * `failed`, which is the honest outcome when a pack names a provider this host
 * did not install — a substitution would run the wrong model and report success.
 *
 * NO HOST CONTENT IS EXPOSED. `inputSpecs` is empty, matching the exposure the
 * plan seals for a V1 provider phase: the provider receives its rendered request
 * and nothing else, and the leg refuses any request that attaches more.
 */

import { parseInvocationId, parseSha256Digest } from "../ids.js";
import type {
  ProviderInvocationHostV1, ProviderInvocationRequestV1,
} from "../runtime/invoke.js";
import type { AuthorizedProviderPaths } from "../packages/paths.js";
import type { ProviderLegInputV1 } from "../../preparations/attempts/provider.js";
import type {
  PackProviderRequestV1, PackProviderRunContextV1, ProviderPhaseExecutorV1,
} from "../../operations-packs/runtime/runner-input.js";
import type { InstalledDevProviderV1 } from "./install.js";
import { devEffectiveGrantRequest, type IssuedDevGrantV1 } from "./grant.js";
import { projectGrantScopeDigest } from "../authority/grants-resolve.js";
import type { ProviderHostBackendV1 } from "./backend-contract.js";
import type { HostModelBrokerV1 } from "../brokers/model.js";
import type { Sha256Digest } from "../types.js";

/** One artifact output a capability declares, as an invocation states it. */
interface DeclaredOutputV1 {
  readonly outputId: string;
  readonly required: boolean;
  readonly mediaType: string;
}

/** Everything one host needs to serve a pack's provider phases. */
export interface DevInvocationHostV1 {
  readonly paths: AuthorizedProviderPaths;
  readonly installed: InstalledDevProviderV1;
  readonly grant: IssuedDevGrantV1;
  readonly backend: ProviderHostBackendV1;
  /**
   * The safety floor this host asserts. The run's workspace, run id, root and
   * surface are NOT here: they arrive per invocation from the run itself,
   * because a host is built before anything is staged and the real run id does
   * not exist until then.
   */
  readonly safetyFloorVersion: string;
  readonly operationContext?: Record<string, unknown>;
  /**
   * The host's model broker and the pinned price table its calls settle
   * against. Absent by default: without it a provider's model broker-request
   * refuses, and the grant must ALSO carry a `model.invoke` atom, bounds with
   * brokerRequests > 0, and the same price-table digest — the broker, the
   * grant, and the price pin are three separate operator decisions.
   */
  readonly model?: DevModelHostV1;
}

/** The model half of a development invocation host. */
export interface DevModelHostV1 {
  readonly broker: HostModelBrokerV1;
  readonly priceTableDigest: Sha256Digest;
}

/** The artifact outputs the installed capability declares it may produce. */
function declaredOutputs(capability: Record<string, unknown>): readonly DeclaredOutputV1[] {
  const outputs = (capability.artifactOutputs ?? []) as Array<Record<string, unknown>>;
  return outputs.map((output) => ({
    outputId: String(output.outputId), required: output.required === true,
    // A contract may admit several media types; an invocation declares the one
    // it will accept, and the first declared type is the capability's own
    // primary rather than a preference invented here.
    mediaType: String((output.mediaTypes as string[] | undefined)?.[0] ?? "application/json"),
  }));
}

/** True when the installed provider is the one this sealed phase names. */
function servesPhase(host: DevInvocationHostV1, executor: ProviderPhaseExecutorV1): boolean {
  return host.installed.providerPinDigest === executor.providerPinDigest
    && String(host.installed.pin.capabilityId) === executor.capabilityId;
}

/**
 * Build the provider invocation for one sealed phase.
 *
 * @param host - The installed provider, its grant, and the backend to run it.
 * @param executor - The phase's sealed executor.
 * @param invocationId - A per-phase invocation identity.
 * @returns The complete invocation request.
 */
async function invocationRequestFor(
  host: DevInvocationHostV1, executor: ProviderPhaseExecutorV1, invocationId: string,
  request: PackProviderRequestV1, context: PackProviderRunContextV1,
): Promise<ProviderInvocationRequestV1> {
  // THE PROJECT COMES FROM THE RUN, NOT FROM THE GRANT. Copying the grant's own
  // digest would make the check tautological: a grant issued for project A would
  // satisfy a run in project B, which is precisely what a project-bound grant
  // exists to prevent. Deriving it here makes the resolver's comparison real.
  const projectRealpathDigest = await projectGrantScopeDigest(context.root);
  const { installed } = host;
  return {
    paths: host.paths,
    invocationId: parseInvocationId(invocationId),
    nonce: `${invocationId}-nonce`,
    // Bound to the RUN this phase belongs to, and the surface it was invoked
    // through — both supplied per invocation rather than remembered.
    authorityRequest: devEffectiveGrantRequest(host.grant, {
      pin: installed.pin, workspaceId: context.workspaceId,
      preparationRunId: context.preparationRunId, surface: context.surface,
      projectRealpathDigest, safetyFloorVersion: host.safetyFloorVersion,
      ...(host.model === undefined ? {} : { priceTableDigest: host.model.priceTableDigest }),
    }),
    // Every field derived from the SEAL or the install record; none invented.
    expectedIdentity: {
      providerPinDigest: parseSha256Digest(executor.providerPinDigest),
      packageDigest: parseSha256Digest(installed.packageDigest),
      manifestDigest: parseSha256Digest(installed.manifestDigest),
      artifactDigest: parseSha256Digest(installed.artifactDigest),
      capabilityId: installed.pin.capabilityId,
      capabilitySchemaDigest: parseSha256Digest(executor.capabilityContractDigest),
    },
    launch: {
      sourceTreeReal: installed.treePath, artifact: installed.artifact,
      // Replaced by the leg with its own custody directory; stated because the
      // request shape requires it.
      launchParentDir: installed.treePath,
    },
    // THE PLATFORM'S RENDERED REQUEST, NOT ONE THIS ADAPTER COMPOSED. The text
    // comes from the plan's own sealed template and the run's frozen input, so
    // the provider is asked exactly what the approved plan says it is asked.
    // The source-evidence specs likewise arrive READY from the runtime's shared
    // builder — this host neither resolves paths nor could widen the sealed
    // set — and the inputId→path table travels in the input under the
    // descriptor's own key so the provider can name the file each claim cites.
    inputSpecs: context.sourceEvidence?.specs ?? [],
    input: providerInputRecord(request, context.sourceEvidence) as never,
    operationContext: (host.operationContext ?? {}) as never,
    declaredOutputs: declaredOutputs(installed.capability),
    custodyValidators: [],
    brokers: host.model === undefined ? {} : { model: host.model.broker },
  } as unknown as ProviderInvocationRequestV1;
}

/**
 * The provider's input record: the path table under the descriptor's own key,
 * then the platform's fields. THE PLATFORM WRITES LAST, so no descriptor key —
 * however it was authored — can displace the sealed rendered request or its
 * template ref; the parser additionally refuses the two reserved keys outright.
 */
export function providerInputRecord(
  request: PackProviderRequestV1, sourceEvidence: PackProviderRunContextV1["sourceEvidence"],
): Readonly<Record<string, unknown>> {
  return {
    ...(sourceEvidence === undefined ? {} : { [sourceEvidence.pathTableKey]: sourceEvidence.pathTable }),
    request: request.text, templateRef: request.templateRef,
  };
}

/**
 * Build the per-phase leg input the pack runtime's provider routing consumes.
 *
 * @param host - The installed provider, its grant, and the backend.
 * @returns A `legInputFor` that serves phases naming this provider and declines
 *   the rest.
 */
export function devProviderInvocation(
  host: DevInvocationHostV1,
): (
  executor: ProviderPhaseExecutorV1, phase: unknown, request: PackProviderRequestV1,
  context: PackProviderRunContextV1,
) => Promise<ProviderLegInputV1 | null> {
  let sequence = 0;
  return async (executor, _phase, request, context) => {
    if (!servesPhase(host, executor)) return null;
    sequence += 1;
    return {
      request: await invocationRequestFor(host, executor, `inv-${sequence}`, request, context),
      host: { backend: host.backend },
      preparationRunId: context.preparationRunId,
    };
  };
}
