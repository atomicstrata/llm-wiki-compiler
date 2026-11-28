/**
 * @file src/portable/host/tickets.ts
 * @description Execution tickets: how a host job applies ONE approved change
 * on a person's behalf without anyone's authority growing.
 *
 * A service's right to apply in a project is a preexisting grant in base
 * policy. A ticket only SELECTS, from authority that already exists, one
 * approved apply for one service. Issuing one grants no permission and no
 * clearance, so it does not move the policy revision and cannot invalidate the
 * approval it names. A ticket alone is not enough: the service must present its
 * own credential, hold its own grant, and the applier must still hold theirs.
 */

import { randomBytes } from "node:crypto";
import { custodyOf, type Authority } from "../authority/status.js";
import type { PrincipalContext } from "../contracts.js";
import { PortableRefusal } from "../errors.js";
import type { ExecutionTicketV1, ProjectControlRecord } from "./control.js";
import { entitlementOf } from "./policy.js";

/** The reservation key a ticket's custody is tracked under. */
export function ticketCustodyKey(ticketId: string): string {
  return `ticket:${ticketId}`;
}

/** A ticket's expiry: the caller's request, capped by the host. */
function cappedExpiry(requested: string, maxTtlMs: number): string {
  const ceiling = Date.now() + maxTtlMs;
  const asked = Date.parse(requested);
  return new Date(Number.isFinite(asked) ? Math.min(asked, ceiling) : ceiling).toISOString();
}

/**
 * Issue a ticket and record it in host control state. Moves the ticket
 * revision only; base policy is untouched.
 */
export async function issueTicket(
  auth: Authority, control: ProjectControlRecord, applier: string,
  request: { approvalId: string; serviceActor: string; requestedExpiresAt: string },
): Promise<ExecutionTicketV1> {
  const ticketRevision = control.ticketRevision + 1;
  const ticket: ExecutionTicketV1 = {
    ticketId: `tkt_${randomBytes(12).toString("hex")}`,
    tenant: control.tenant, project: control.projectId, approvalId: request.approvalId,
    serviceActor: request.serviceActor, applier, issuedAtTicketRevision: ticketRevision,
    expiresAt: cappedExpiry(request.requestedExpiresAt, auth.control.limits.maxTicketTtlMs), revoked: false,
  };
  await auth.control.saveProject({ ...control, ticketRevision, tickets: [...control.tickets, ticket] });
  return ticket;
}

/**
 * The ticket a delegated apply presents, checked against everything it must
 * still be: issued for this approval and this service, unexpired, unrevoked,
 * unused, and backed by an applier who still may apply.
 *
 * @throws PortableRefusal `ticket_invalid`, or `permission_denied` when the
 *   applier no longer holds `publication.apply`.
 */
export async function ticketForApply(
  auth: Authority, control: ProjectControlRecord, principal: PrincipalContext, ticketId: string | undefined, approvalId: string,
): Promise<ExecutionTicketV1> {
  const ticket = control.tickets.find((entry) => entry.ticketId === ticketId);
  const usable = ticket !== undefined && ticket.approvalId === approvalId && ticket.serviceActor === principal.actor
    && !ticket.revoked && Date.parse(ticket.expiresAt) > Date.now();
  if (!usable) throw new PortableRefusal("ticket_invalid");
  if ((await custodyOf(auth, ticketCustodyKey(ticket.ticketId))).state !== "available") {
    throw new PortableRefusal("ticket_invalid");
  }
  if (!entitlementOf(control, ticket.applier).permissions.has("publication.apply")) {
    throw new PortableRefusal("permission_denied");
  }
  return ticket;
}
