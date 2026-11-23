/**
 * @file src/portable/scale/cursor.ts
 * @description The opaque keyset cursor of a paged listing.
 *
 * A cursor is a POSITION, bound to the tenant, the project, the canonical
 * predicate and the fence it was issued under. It carries no authority: it
 * names no principal, role or label, and holding one entitles its holder to
 * nothing. Authorization is decided from current host state before a cursor is
 * even looked at, and every item on the next page is authorized again.
 *
 * It is keyed with the host secret so a client cannot mint or edit one. A
 * cursor that fails that check, or whose binding differs in any part from the
 * request it is presented with (another tenant, another project, another
 * predicate, or a fence that has since moved), does not resolve. The caller
 * reports that as `stale_cursor`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Separates cursor keys from every other use of the host secret. */
const CURSOR_DOMAIN = "portable-scale/2:cursor\n";

/** Everything a cursor is bound to besides its position. */
export interface CursorBinding { tenant: string; project: string; predicate: string; fence: string }

/** The keyed tag of one cursor payload. */
function tagOf(secret: Buffer, payload: string): Buffer {
  return createHmac("sha256", secret).update(CURSOR_DOMAIN).update(payload).digest();
}

/** Issue a cursor that resumes strictly after `after` under `binding`. */
export function encodeCursor(secret: Buffer, binding: CursorBinding, after: string): string {
  const payload = JSON.stringify([binding.tenant, binding.project, binding.predicate, binding.fence, after]);
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${tagOf(secret, payload).toString("base64url")}`;
}

/**
 * Resolve a cursor presented with `binding`.
 *
 * @returns The position to resume after, or `null` when the cursor is not
 *   this host's, was altered, or is bound to anything other than `binding`.
 */
export function decodeCursor(secret: Buffer, binding: CursorBinding, cursor: string): string | null {
  const [encoded, tag, ...rest] = cursor.split(".");
  if (encoded === undefined || tag === undefined || rest.length > 0) return null;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const presented = Buffer.from(tag, "base64url");
  const expected = tagOf(secret, payload);
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) return null;
  const [tenant, project, predicate, fence, after] = JSON.parse(payload) as string[];
  const isBoundHere = tenant === binding.tenant && project === binding.project
    && predicate === binding.predicate && fence === binding.fence;
  return isBoundHere && typeof after === "string" ? after : null;
}
