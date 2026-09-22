/**
 * @file src/operation-bundles/principal.ts
 * @description Closed, transport-independent authority DTOs for operation
 * execution. This module intentionally loads no environment or host config;
 * callers must supply the principal and its already-resolved grants.
 */

/** Every transport surface recognized by the operation principal contract. */
export const OPERATION_PRINCIPAL_SURFACES = Object.freeze([
  "cli",
  "sdk",
  "mcp",
] as const);

export type OperationPrincipalSurface = (typeof OPERATION_PRINCIPAL_SURFACES)[number];

/** Every host-configurable operation grant recognized by Milestone A. */
export const OPERATION_GRANTS = Object.freeze([
  "operation-bundle.prepare",
  "operation-bundle.approve",
  "operation-bundle.reject",
  "operation-bundle.revise",
  "operation-bundle.cancel",
  "operation-bundle.abandon",
  "operation-bundle.quarantine",
  "operation-bundle.quarantine-purge",
] as const);

export type OperationGrant = (typeof OPERATION_GRANTS)[number];

/** Explicit authority passed into review, execution, and recovery. */
export interface OperationPrincipal {
  id: string;
  surface: OperationPrincipalSurface;
  grants: readonly OperationGrant[];
}
