/**
 * @file src/portable/host/operation-ids.ts
 * @description Host-allocated operation ids.
 *
 * A caller obtains an id BEFORE it submits anything, so a lost response always
 * leaves something to ask about. An id is bound to the project, the host
 * incarnation and the actor it was allocated for: it carries a keyed digest
 * over those, so the host verifies one without keeping an allocation table,
 * and an id presented for another project, another incarnation or by another
 * actor is simply not valid.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrincipalContext } from "../contracts.js";
import type { HostControl } from "./control.js";

const ID_PREFIX = "op_";
const NONCE_HEX = 16;
const TAG_HEX = 24;

/** The keyed tag binding a nonce to its origin. */
function tagFor(control: HostControl, principal: PrincipalContext, nonce: string): string {
  const origin = [principal.tenant, principal.project, control.incarnation, principal.actor, nonce].join("\n");
  return createHmac("sha256", control.secret).update(origin).digest("hex").slice(0, TAG_HEX);
}

/** Allocate a fresh operation id for `principal`. */
export function allocateOperationId(control: HostControl, principal: PrincipalContext): string {
  const nonce = randomBytes(NONCE_HEX / 2).toString("hex");
  return `${ID_PREFIX}${nonce}${tagFor(control, principal, nonce)}`;
}

/** True when `operationId` was allocated by this host for this project and actor. */
export function isOperationIdValid(control: HostControl, principal: PrincipalContext, operationId: string): boolean {
  if (!new RegExp(`^${ID_PREFIX}[0-9a-f]{${NONCE_HEX + TAG_HEX}}$`).test(operationId)) return false;
  const nonce = operationId.slice(ID_PREFIX.length, ID_PREFIX.length + NONCE_HEX);
  const presented = Buffer.from(operationId.slice(ID_PREFIX.length + NONCE_HEX), "hex");
  const expected = Buffer.from(tagFor(control, principal, nonce), "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
