/**
 * @file src/portable/scale/remote-paged.ts
 * @description The client side of the paged protocol: a transport and nothing
 * more, like the version 1 remote session beside it.
 *
 * Every call states the protocol it speaks, sends the caller's credential and
 * the caller's own inputs, and accepts an answer only if it is one of the
 * kinds that method can return, with a refusal code from the paged union. It
 * builds no cursor, label or fence of its own: a cursor is whatever the host
 * issued, sent back unchanged.
 */

import { PortableDenied, PortableRefusal } from "../errors.js";
import { readEnvelope } from "../remote/outcome-validation.js";
import type { RemoteTarget } from "../remote/remote-session.js";
import { decodeWire, encodeWire } from "../remote/wire.js";
import { PAGED_REFUSAL_CODES_V2, SCALE_PROTOCOL_V2, type PagedProjectV2 } from "./contracts.js";
import { SCALE_PATH_PREFIX, SCALE_PROTOCOL_HEADER, type ScaleRemoteMethodV2 } from "./wire.js";

/** True when `answer` is an outcome this method can return, with a known refusal code if it is one. */
function isPagedOutcome(answer: unknown, kinds: readonly string[]): boolean {
  if (answer === null || typeof answer !== "object") return false;
  const { kind, code } = answer as { kind?: unknown; code?: unknown };
  if (kind === "refused") return PAGED_REFUSAL_CODES_V2.some((known) => known === code);
  return kinds.some((known) => known === kind);
}

/** Send one paged call and return the host's outcome. */
async function callScale<T>(
  target: RemoteTarget, method: ScaleRemoteMethodV2, kinds: readonly string[], ...args: unknown[]
): Promise<T> {
  const host = target.host.replace(/\/+$/u, "");
  const response = await fetch(`${host}${SCALE_PATH_PREFIX}${encodeURIComponent(target.project)}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", authorization: `Bearer ${target.token}`,
      [SCALE_PROTOCOL_HEADER]: SCALE_PROTOCOL_V2,
    },
    body: JSON.stringify({ args: encodeWire(args) }),
  });
  const envelope = readEnvelope(await response.json());
  if (envelope.kind === "refused") throw new PortableRefusal(envelope.code);
  // A host that does not speak the protocol does not know the path: that is a denial, not a paged answer.
  if (envelope.kind === "denied") throw new PortableDenied();
  const answer = envelope.kind === "result" ? decodeWire(envelope.result) : null;
  if (!isPagedOutcome(answer, kinds)) throw new Error("the host did not establish a paged outcome");
  return answer as T;
}

/** The paged reads of a hosted project, each a remote call. */
export function remotePagedProject(target: RemoteTarget): PagedProjectV2 {
  return {
    protocol: SCALE_PROTOCOL_V2,
    negotiate: () => callScale(target, "negotiate", ["negotiated"]),
    pages: {
      listPage: (request = {}) => callScale(target, "pages.listPage", ["page"], request),
      open: (id) => callScale(target, "pages.open", ["opened", "not_visible"], id),
    },
    search: (request) => callScale(target, "search", ["results"], request),
  };
}
