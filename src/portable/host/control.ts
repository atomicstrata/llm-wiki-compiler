/**
 * @file src/portable/host/control.ts
 * @description Host control state: the authority a project can never edit.
 *
 * Role bindings, service grants, execution tickets, the policy and ticket
 * revisions and a project's identity all live here, outside project content.
 * Nothing a compile, an import or a hand edit writes into a project can grant,
 * widen or bind a permission. Every authorization decision reads the CURRENT
 * record through {@link HostControl.loadProject}; nothing is cached in a session.
 */

import type { Permission } from "../contracts.js";

/** The prototype's default roles. Each is stated in full; none works by an unstated grant. */
export type RoleName = "viewer" | "contributor" | "reviewer" | "publisher" | "owner";

const VIEWER: readonly Permission[] = ["project.open", "page.list", "page.read", "query.run"];

/** The permissions each default role carries (spec §10.2). */
export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  viewer: VIEWER,
  contributor: [...VIEWER, "source.read", "source.write", "compile.propose", "model.invoke", "candidate.read"],
  reviewer: [...VIEWER, "source.read", "candidate.read", "candidate.approve"],
  publisher: [...VIEWER, "candidate.read", "publication.apply", "ticket.issue"],
  owner: [
    ...VIEWER, "source.read", "source.write", "compile.propose", "model.invoke", "candidate.read",
    "candidate.approve", "publication.apply", "ticket.issue", "export.run", "operation.read",
    "operation.resolve", "project.admin",
  ],
};

/** A host-issued, single-use selection of ONE approved apply for one service. */
export interface ExecutionTicketV1 {
  ticketId: string;
  tenant: string;
  project: string;
  approvalId: string;
  /** The real executor. It must hold its OWN preexisting grant. */
  serviceActor: string;
  /** Recorded as on-behalf-of. Holds `publication.apply` and `ticket.issue`. */
  applier: string;
  issuedAtTicketRevision: number;
  /** Host-capped. */
  expiresAt: string;
  revoked: boolean;
}

/** One project's authoritative control record. */
export interface ProjectControlRecord {
  projectId: string;
  tenant: string;
  /** Portable format/protocol version. Every capable binary validates it (D24). */
  formatVersion: 1 | 2;
  requiredFeatures: readonly string[];
  /** The project's single mandatory compartment in the prototype. */
  compartment: string;
  /** Base policy only: bindings and service grants. Tickets do not move it. */
  policyRevision: number;
  /** Moves when a ticket is issued or revoked. Never invalidates an approval. */
  ticketRevision: number;
  bindings: readonly { subject: string; roles: readonly RoleName[] }[];
  /** Preexisting authority of a service identity; never created for one approval. */
  serviceGrants: readonly { service: string; permissions: readonly Permission[] }[];
  tickets: readonly ExecutionTicketV1[];
  /** Local projects only: the canonical root this identity was issued for. */
  canonicalRoot: string | null;
  /**
   * The host incarnation that issued this registration. If the host's identity
   * is ever lost and re-minted, an old registration no longer matches and is
   * refused: nothing re-attaches an old project and its ledger to a new host.
   */
  hostIncarnation: string;
}

/** The features a binary must support to mutate a registered project. */
export const REQUIRED_FEATURES = [
  "portable-recovery-owner", "pending-intent-gate", "read-visibility-gate", "retained-pre-images",
] as const;

/**
 * True when this binary fully supports a registration record (D24): the format
 * version it understands and no required feature it lacks.
 */
export function isSupportedRegistration(record: Pick<ProjectControlRecord, "formatVersion" | "requiredFeatures">): boolean {
  return registrationMode(record) === "format-1" || registrationMode(record) === "format-2";
}

/**
 * The features a format-2 registration requires beyond format 1's (alignment
 * §7.2 rule 5). A binary that does not know them refuses to mutate the project,
 * which is how older portable-aware binaries (verified: published 1.5.0) are excluded once a project adopts it.
 */
export const FORMAT2_FEATURES = ["maintained-open-operations", "state-custody"] as const;

/**
 * Present only while an adoption is part-way through. No binary supports it as
 * an ordinary feature, so old binaries AND this one refuse ordinary opens and
 * mutations until the adoption command completes; only that command resumes it.
 */
export const ADOPTING_FEATURE = "format-2-adoption-in-progress";

/** How this binary reads a registration. */
export type RegistrationMode = "format-1" | "format-2" | "adopting" | "unsupported";

/** True when every one of `features` is in `known`. */
function hasOnly(features: readonly string[], known: readonly string[]): boolean {
  return features.every((feature) => known.includes(feature));
}

/** Classify a registration record for this binary. */
export function registrationMode(record: Pick<ProjectControlRecord, "formatVersion" | "requiredFeatures">): RegistrationMode {
  const format1: readonly string[] = REQUIRED_FEATURES;
  const format2: readonly string[] = [...REQUIRED_FEATURES, ...FORMAT2_FEATURES];
  const features = record.requiredFeatures;
  if (record.formatVersion === 1) return hasOnly(features, format1) ? "format-1" : "unsupported";
  if (record.formatVersion !== 2) return "unsupported";
  if (features.includes(ADOPTING_FEATURE)) return hasOnly(features, [...format1, ADOPTING_FEATURE]) ? "adopting" : "unsupported";
  return hasOnly(features, format2) && FORMAT2_FEATURES.every((feature) => features.includes(feature)) ? "format-2" : "unsupported";
}

/** Host-set ceilings a caller's requested expiry is capped to. */
export interface HostLimits {
  maxApprovalTtlMs: number;
  maxTicketTtlMs: number;
  maxLeaseMs: number;
}

/** Default ceilings for the prototype. */
export const DEFAULT_HOST_LIMITS: HostLimits = {
  maxApprovalTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxTicketTtlMs: 60 * 60 * 1000,
  maxLeaseMs: 10 * 60 * 1000,
};

/** The control plane of one host. */
export interface HostControl {
  /** Identity of this host instance; operation ids and tokens are bound to it. */
  readonly incarnation: string;
  /** Keys operation ids so an id minted elsewhere is never honoured. */
  readonly secret: Buffer;
  readonly limits: HostLimits;
  /** The current record, or `null` when this host has no such project. */
  loadProject(projectId: string): Promise<ProjectControlRecord | null>;
  saveProject(record: ProjectControlRecord): Promise<void>;
  /** Record the true reason for a decision. Never returned to a caller. */
  audit(event: Record<string, unknown>): void;
}
