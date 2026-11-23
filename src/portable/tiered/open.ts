/**
 * @file src/portable/tiered/open.ts
 * @description The SDK entry point of slice S4: open a project's tier surface,
 * stating `portable-tiers/2`, beside `openProject`, which is unchanged.
 *
 * It returns the tier methods and the S2a review chain of the same project —
 * coverage, candidates, approval and apply — so a promotion can be reviewed,
 * approved by a reviewer and applied by a publisher without another session
 * kind. Who may approve is S2's role check: it requires `candidate.approve`
 * and does not forbid a person holding both roles from approving their own
 * proposal.
 * Over HTTP the client is a transport and nothing more: it states the
 * protocol, sends the credential and the caller's own inputs, and accepts an
 * answer only if it is one of the kinds that method can return. A review
 * method keeps its scoped contract: the route's own refusal (a denied session,
 * a capped body) is raised as an error, as the version 1 transport raises it,
 * never returned in place of a scoped outcome.
 *
 * A local registered directory has no tiers: every tier method refuses with
 * `capability_unsupported` naming `tieredSearch`, the review writes with the
 * scoped protocol's own refusal naming scope fences, and the review reads
 * show nothing; nothing is emulated.
 */

import { ACCESS_NOTICE } from "../contracts.js";
import { PortableDenied, PortableRefusal } from "../errors.js";
import { isEstablishedOutcome } from "../remote/outcome-validation.js";
import { SCOPE_FENCES_CAPABILITY, type ScopedProjectV2 } from "../scoped/contracts.js";
import { UNSUPPORTED_PROJECT } from "../scoped/unsupported.js";
import { decodeWire } from "../remote/wire.js";
import { SCALE_PROTOCOL_HEADER } from "../scale/wire.js";
import {
  TIERS_CAPABILITY, TIERS_PATH_PREFIX, TIERS_PROTOCOL_V2, TIERS_REFUSAL_CODES_V2, type PromoteRequestV2, type TieredProjectV2, type TiersMethod, type TiersRefusedV2,
} from "./contracts.js";

/** What `openTieredProject` needs. */
export interface OpenTieredOptions {
  project: { host: string; project: string } | { localRoot: string };
  credential: { kind: "host-token"; token: string } | { kind: "local-os" };
  /** Must include `portable-tiers/2`. Nothing is inferred from its absence. */
  protocols: readonly string[];
}

/** The S2a review chain of the same project, as the tier session carries it. */
export type TieredReviewV2 = Pick<ScopedProjectV2, "coverage" | "candidates" | "apply">;

/** A project's tier surface and its review chain. */
export interface TieredSessionV2 { tiers: TieredProjectV2; review: TieredReviewV2 }

/** Where one hosted project is, and the credential that opens it. */
interface TiersTarget { host: string; project: string; token: string }

const UNSUPPORTED: TiersRefusedV2 = { kind: "refused", code: "capability_unsupported", capability: TIERS_CAPABILITY, notice: ACCESS_NOTICE };

/** The kinds each tier method can answer with, besides a refusal from the tier union. */
const TIER_KINDS: Readonly<Record<"negotiate" | "search" | "triage" | "promote", readonly string[]>> = {
  negotiate: ["negotiated"], search: ["results"], triage: ["triage", "fenced", "not_visible"], promote: ["promoted"],
};

/** A loosely typed record read off the wire. */
type Wire = Record<string, unknown>;
const isRecord = (value: unknown): value is Wire => value !== null && typeof value === "object" && !Array.isArray(value);
const isScopedUnsupported = (answer: Wire): boolean =>
  answer.kind === "refused" && answer.code === "capability_unsupported" && answer.capability === SCOPE_FENCES_CAPABILITY;

/** Post one call and decode the host's answer, unchecked. */
async function post(target: TiersTarget, method: TiersMethod, body: unknown): Promise<unknown> {
  const response = await fetch(`${target.host.replace(/\/+$/u, "")}${TIERS_PATH_PREFIX}${encodeURIComponent(target.project)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.token}`, [SCALE_PROTOCOL_HEADER]: TIERS_PROTOCOL_V2 },
    body: JSON.stringify(body),
  });
  return decodeWire(await response.json());
}

/**
 * True when a `promoted` answer is established for the HELD operation: its
 * nested proposal is a complete scoped propose outcome of exactly that id (or
 * the scoped protocol's own refusal), and it says whether the finding's bytes
 * were compiled.
 */
function isPromotionOf(answer: Wire, request: PromoteRequestV2): boolean {
  const proposal = answer.proposal;
  const isProposal = isRecord(proposal) && (isScopedUnsupported(proposal) || isEstablishedOutcome("propose", proposal, request));
  return isProposal && typeof answer.compiledFindingBytes === "boolean";
}

/** One tier call: the answer must be a kind the method returns, or a refusal from the tier union. */
async function tierCall<T>(target: TiersTarget, method: keyof typeof TIER_KINDS, body: unknown = {}): Promise<T> {
  const answer = await post(target, method, body);
  const isKnown = isRecord(answer) && (answer.kind === "refused"
    ? TIERS_REFUSAL_CODES_V2.some((code) => code === answer.code)
    : TIER_KINDS[method].some((kind) => kind === answer.kind));
  const isHeld = method !== "promote" || !isRecord(answer) || answer.kind !== "promoted" || isPromotionOf(answer, body as PromoteRequestV2);
  if (!isKnown || !isHeld) throw new Error(`the host did not establish a ${method} outcome`);
  return answer as T;
}

/**
 * One review call: the route's OWN refusal (a denied session, a capped body)
 * is not a scoped outcome, so it is raised as a transport raises it; anything
 * else must be the scoped method's own outcome.
 */
async function reviewCall<T>(target: TiersTarget, method: TiersMethod, body: unknown, isOutcome: (answer: Wire) => boolean): Promise<T> {
  const answer = await post(target, method, body);
  if (!isRecord(answer)) throw new Error(`the host did not establish a ${method} outcome`);
  const isRouteRefusal = answer.kind === "refused" && !("operationId" in answer) && !isScopedUnsupported(answer);
  if (isRouteRefusal && answer.code === "permission_denied") throw new PortableDenied();
  if (isRouteRefusal) throw new PortableRefusal(answer.code === "limit_exceeded" ? "limit_exceeded" : "operation_unsupported_on_portable_path");
  if (!isOutcome(answer)) throw new Error(`the host did not establish a ${method} outcome`);
  return answer as T;
}

/** The review chain of a hosted project, each answer checked against its scoped method's outcome. */
function remoteReview(target: TiersTarget): TieredReviewV2 {
  const isVisibleResult = (answer: Wire): boolean => typeof answer.visible === "boolean";
  return {
    coverage: (proposalOperationId) => reviewCall(target, "scoped.coverage", { proposalOperationId }, isVisibleResult),
    candidates: {
      list: (proposalOperationId) => reviewCall(target, "scoped.candidates.list", { proposalOperationId }, (answer) => Array.isArray(answer.items)),
      get: (proposalOperationId, candidateId) => reviewCall(target, "scoped.candidates.get", { proposalOperationId, candidateId }, isVisibleResult),
      approve: (request) => reviewCall(target, "scoped.approve", request,
        (answer) => isScopedUnsupported(answer) || isEstablishedOutcome("candidates.approve", answer, request)),
    },
    apply: (request) => reviewCall(target, "scoped.apply", request, (answer) => isScopedUnsupported(answer) || isEstablishedOutcome("apply", answer, request)),
  };
}

/** The surface of a hosted project, each method a remote call. */
function remoteSession(target: TiersTarget): TieredSessionV2 {
  return {
    tiers: {
      protocol: TIERS_PROTOCOL_V2,
      negotiate: () => tierCall(target, "negotiate"),
      search: (request) => tierCall(target, "search", request),
      triage: (request) => tierCall(target, "triage", request),
      promote: (request) => tierCall(target, "promote", request),
    },
    review: remoteReview(target),
  };
}

/** The surface of a project with no tiers: tier methods refuse naming `tieredSearch`; the review chain is the scoped protocol's own unsupported surface. */
function unsupportedSession(): TieredSessionV2 {
  const refuse = async (): Promise<TiersRefusedV2> => UNSUPPORTED;
  return { tiers: { protocol: TIERS_PROTOCOL_V2, negotiate: refuse, search: refuse, triage: refuse, promote: refuse }, review: UNSUPPORTED_PROJECT };
}

/**
 * Open the tier surface of a project.
 *
 * @throws TypeError when the caller does not state the protocol, or a hosted project lacks a host token.
 */
export function openTieredProject(options: OpenTieredOptions): TieredSessionV2 {
  if (!options.protocols.includes(TIERS_PROTOCOL_V2)) {
    throw new TypeError(`openTieredProject requires the caller to state the ${TIERS_PROTOCOL_V2} protocol`);
  }
  if ("localRoot" in options.project) return unsupportedSession();
  if (options.credential.kind !== "host-token") throw new TypeError("a hosted project needs a host token");
  return remoteSession({ ...options.project, token: options.credential.token });
}
