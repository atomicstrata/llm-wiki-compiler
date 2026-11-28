/**
 * @file src/portable/federation/open.ts
 * @description The SDK entry point of slice S6: open a federation on its
 * receiver, stating `portable-federation/2`, beside `openProject`, which is
 * unchanged.
 *
 * The client is a transport and nothing more. It checks every request's
 * shape and bounds exactly as the host will, before sending; it sends the
 * receiver's token as the bearer and the caller's other shard tokens in the
 * body; and it accepts an answer only if it is one of the kinds that method
 * can return. Tokens are never logged or returned. A local registered
 * directory has no federation: every method refuses `capability_unsupported`
 * naming `federation`, and nothing is emulated.
 */

import { bytesDigest } from "../digest.js";
import { isEstablishedOutcome, type WriteMethod } from "../remote/outcome-validation.js";
import { decodeWire } from "../remote/wire.js";
import { SCALE_PROTOCOL_HEADER } from "../scale/wire.js";
import {
  FEDERATION_PATH_PREFIX, FEDERATION_PROTOCOL_V2, FEDERATION_REFUSAL_CODES_V2, type FederationRefusedV2, type FederationSessionV2, type ShardCredentialV2,
} from "./contracts.js";
import { federationRefused } from "./refusals.js";
import { requestVerdict, type FederationMethod } from "./validate.js";

/** What `openFederation` needs. */
export interface OpenFederationOptions {
  /** A hosted receiver, or a local directory (which has no federation). */
  receiver: { host: string; project: string; token: string } | { localRoot: string };
  federationId: string;
  /** The caller's own credentials for the other shards this session may touch. */
  shards: readonly ShardCredentialV2[];
  /** Must include `portable-federation/2`. Nothing is inferred from its absence. */
  protocols: readonly string[];
}

/** The kinds each method can answer with, besides this protocol's refusal. */
const KINDS: Readonly<Record<FederationMethod, readonly string[]>> = {
  "search": ["results"], "links": ["links", "not_visible"], "quality": ["quality"],
  "overview.propose": ["proposed", "refused", "rejected", "in_progress", "unknown"],
  "overview.list": [], "overview.get": [], "overview.approval": [],
  "overview.approve": ["approved", "refused", "rejected", "in_progress", "unknown"],
  "overview.apply": ["committed", "refused", "rejected", "in_progress", "unknown"],
  "overview.read": ["opened", "not_visible"], "queue": ["queue"], "group": ["grouped"],
};

type Wire = Record<string, unknown>;

/** True when `answer` is a refusal of this protocol. */
function isFederationRefusal(answer: Wire): boolean {
  return answer.kind === "refused" && FEDERATION_REFUSAL_CODES_V2.some((code) => code === answer.code) && !("operationId" in answer);
}

/** The shared write each held overview write is, for establishing its outcome. */
const HELD_WRITES: Partial<Record<FederationMethod, WriteMethod>> = {
  "overview.propose": "propose", "overview.approve": "candidates.approve", "overview.apply": "apply",
};

/** The shared write request a grouped entry is, exactly as its shard received it. */
function heldRequestOf(entry: { kind: string; operationId: string; name?: string; text?: string; approvalId?: string }): { write: WriteMethod; request: { operationId: string } } {
  if (entry.kind !== "source.add") return { write: "apply", request: { operationId: entry.operationId, approvalId: entry.approvalId } as { operationId: string } };
  const bytes = Buffer.from(entry.text ?? "", "utf8");
  return { write: "sources.add", request: { operationId: entry.operationId, name: entry.name, upload: { bytes, byteDigest: bytesDigest(bytes) } } as { operationId: string } };
}

/** True when a grouped answer reports exactly the request's entries, each established for its own held id. */
function isGroupOf(answer: Wire, body: Wire): boolean {
  const entries = (body.entries ?? []) as { kind: string; operationId: string; name?: string; text?: string; approvalId?: string }[];
  const results = answer.entries;
  if (!Array.isArray(results) || results.length !== entries.length || typeof answer.complete !== "boolean") return false;
  const isEntry = (result: Wire, index: number): boolean => {
    if (result === null || typeof result !== "object" || result.index !== index) return false;
    if (result.kind === "not_visible") return !("outcome" in result);
    const { write, request } = heldRequestOf(entries[index]!);
    return isEstablishedOutcome(write, result.outcome, request);
  };
  const isComplete = results.every((result: Wire) => (result.outcome as Wire | undefined)?.kind === "committed");
  return (results as Wire[]).every(isEntry) && answer.complete === isComplete;
}

/** True when `answer` is a kind `method` returns, established for what was sent. */
function isKnown(method: FederationMethod, answer: Wire, body: Wire): boolean {
  if (method === "overview.list") return Array.isArray(answer.items);
  if (method === "overview.get" || method === "overview.approval") return typeof answer.visible === "boolean";
  const held = HELD_WRITES[method];
  if (held !== undefined) return isEstablishedOutcome(held, answer, body as { operationId: string });
  if (method === "group") return answer.kind === "grouped" && isGroupOf(answer, body);
  return typeof answer.kind === "string" && KINDS[method].includes(answer.kind);
}

/** One call: checked before sending, and its answer checked on return. */
async function call<T>(target: { host: string; project: string; token: string }, method: FederationMethod, body: Wire): Promise<T | FederationRefusedV2> {
  const verdict = requestVerdict(method, body);
  if (verdict !== null) return federationRefused(verdict);
  const response = await fetch(`${target.host.replace(/\/+$/u, "")}${FEDERATION_PATH_PREFIX}${encodeURIComponent(target.project)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.token}`, [SCALE_PROTOCOL_HEADER]: FEDERATION_PROTOCOL_V2 },
    body: JSON.stringify(body),
  });
  const answer = decodeWire(await response.json()) as Wire;
  if (answer === null || typeof answer !== "object") throw new Error(`the host did not establish a ${method} outcome`);
  if (isFederationRefusal(answer)) return answer as unknown as FederationRefusedV2;
  if (!isKnown(method, answer, body)) throw new Error(`the host did not establish a ${method} outcome`);
  return answer as T;
}

/** The session over a hosted receiver. */
function remoteSession(target: { host: string; project: string; token: string }, scope: { federationId: string; shards: readonly ShardCredentialV2[] }): FederationSessionV2 {
  const with_ = (method: FederationMethod, body: Wire = {}) => call<never>(target, method, { ...scope, ...body });
  return {
    protocol: FEDERATION_PROTOCOL_V2,
    search: (request) => with_("search", { ...request }),
    links: (request) => with_("links", { ...request }),
    quality: () => with_("quality"),
    overview: {
      propose: (request) => with_("overview.propose", { ...request }),
      list: (proposalOperationId) => with_("overview.list", { proposalOperationId }),
      get: (proposalOperationId, candidateId) => with_("overview.get", { proposalOperationId, candidateId }),
      approve: (request) => with_("overview.approve", { ...request }),
      approval: (approvalId) => with_("overview.approval", { approvalId }),
      apply: (request) => with_("overview.apply", { ...request }),
      read: (slug) => with_("overview.read", { slug }),
    },
    queue: (request = {}) => with_("queue", { ...request }),
    group: (entries) => with_("group", { entries }),
  };
}

/** The session of a directory with no federation: every method refuses naming the capability. */
function unsupportedSession(): FederationSessionV2 {
  const refuse = async (): Promise<FederationRefusedV2> => federationRefused("capability_unsupported");
  return {
    protocol: FEDERATION_PROTOCOL_V2, search: refuse, links: refuse, quality: refuse,
    overview: { propose: refuse, list: refuse, get: refuse, approve: refuse, approval: refuse, apply: refuse, read: refuse },
    queue: refuse, group: refuse,
  };
}

/**
 * Open a federation on its receiver.
 *
 * @throws TypeError when the caller does not state the protocol.
 */
export function openFederation(options: OpenFederationOptions): FederationSessionV2 {
  if (!options.protocols.includes(FEDERATION_PROTOCOL_V2)) {
    throw new TypeError(`openFederation requires the caller to state the ${FEDERATION_PROTOCOL_V2} protocol`);
  }
  if ("localRoot" in options.receiver) return unsupportedSession();
  const { host, project, token } = options.receiver;
  return remoteSession({ host, project, token }, { federationId: options.federationId, shards: options.shards });
}
