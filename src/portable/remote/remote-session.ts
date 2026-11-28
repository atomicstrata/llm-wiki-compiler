/**
 * @file src/portable/remote/remote-session.ts
 * @description A client's session with a host: a TRANSPORT and nothing more.
 *
 * It implements the same {@link WikiProject} interface as a local session by
 * sending each call to the host with the caller's credential and the caller's
 * own inputs. It builds no read-set, label, plan, fence or pre-image, and it
 * holds no principal of its own: what it reports as the session's principal is
 * what the host said it derived. The compile runs in the host.
 */

import { PortableDenied, PortableRefusal } from "../errors.js";
import type { PrincipalContext } from "../contracts.js";
import type { DeferredOperations, ExportItem, ProjectSession, WikiProject } from "../project/api.js";
import { isEstablishedOutcome, readEnvelope, type WriteMethod } from "./outcome-validation.js";
import { decodeWire, encodeWire, type RemoteMethod } from "./wire.js";

/** Where the host is, which project, and the credential to present. */
export interface RemoteTarget {
  host: string;
  project: string;
  token: string;
}

/** Send one call and return the host's answer, or throw what it refused with. */
async function call<T>(target: RemoteTarget, method: RemoteMethod, ...args: unknown[]): Promise<T> {
  const url = `${target.host.replace(/\/+$/u, "")}/v1/${encodeURIComponent(target.project)}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
    body: JSON.stringify({ args: encodeWire(args) }),
  });
  const envelope = readEnvelope(await response.json());
  if (envelope.kind === "result") return decodeWire(envelope.result) as T;
  if (envelope.kind === "refused") throw new PortableRefusal(envelope.code);
  if (envelope.kind === "denied") throw new PortableDenied();
  throw new Error("the host did not establish an outcome");
}

/**
 * Send one id-bearing WRITE. A host refusal, rejection or denial is an
 * established answer and is returned or thrown as such. Anything else — a
 * dropped connection, an unreadable response, a host failure — establishes
 * nothing, so it is reported as `unknown` with the id the caller already
 * holds. Nothing is retried and no id is allocated here: the caller asks
 * `status` or repeats the SAME call.
 */
async function write<T>(target: RemoteTarget, method: WriteMethod, request: { operationId: string }): Promise<T> {
  const unknown = { kind: "unknown", operationId: request.operationId } as T;
  try {
    const answer = await call<unknown>(target, method, request);
    // A response that parsed is still not an answer unless it is an outcome
    // THIS method can return, about THIS operation, with its payload present.
    return isEstablishedOutcome(method, answer, request) ? answer as T : unknown;
  } catch (error) {
    if (error instanceof PortableRefusal || error instanceof PortableDenied) throw error;
    return unknown;
  }
}

/** Every deferred domain, forwarded so the host gives the typed refusal itself. */
function remoteDeferred(target: RemoteTarget): DeferredOperations {
  const forward = (name: string) => () => call<never>(target, "deferred", name);
  return {
    downloadRawSource: forward("downloadRawSource"), trashSource: forward("trashSource"),
    restoreSource: forward("restoreSource"), purgeSource: forward("purgeSource"),
    addRelation: forward("addRelation"), transitionLifecycle: forward("transitionLifecycle"),
    readHistory: forward("readHistory"), publishDirect: forward("publishDirect"),
    relabel: forward("relabel"), exportLegacy: forward("exportLegacy"),
  };
}

/** The export stream as the host produced it, including its explicit end item. */
async function* remoteExport(target: RemoteTarget): AsyncIterable<ExportItem> {
  yield* await call<ExportItem[]>(target, "export");
}

/** The project interface, with every member a remote call. */
function remoteProject(target: RemoteTarget): WikiProject {
  const to = <T>(method: RemoteMethod) => (...args: unknown[]) => call<T>(target, method, ...args);
  return {
    id: target.project,
    capabilities: to("capabilities"),
    allocateOperation: to("allocateOperation"),
    pages: { get: to("pages.get"), list: to("pages.list") },
    sources: { get: to("sources.get"), add: (request) => write(target, "sources.add", request) },
    propose: (request) => write(target, "propose", request),
    candidates: {
      list: to("candidates.list"), get: to("candidates.get"),
      approve: (request) => write(target, "candidates.approve", request),
    },
    approvals: { get: to("approvals.get") },
    apply: (request) => write(target, "apply", request),
    status: to("status"),
    resolve: to("resolve"),
    issueExecutionTicket: to("issueExecutionTicket"),
    search: to("search"),
    export: () => remoteExport(target),
    deferred: remoteDeferred(target),
  };
}

/**
 * Open a session with a host. The principal is the one the host derived from
 * the credential.
 *
 * @throws PortableDenied for an unknown project, a bad credential or an unbound principal.
 */
export async function openRemoteProject(target: RemoteTarget): Promise<ProjectSession> {
  const principal = await call<PrincipalContext>(target, "session");
  return { principal, project: remoteProject(target), close: async () => undefined };
}
