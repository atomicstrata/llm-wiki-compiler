/**
 * @file src/connectors/types.ts
 * @description First-party connector contracts and DTOs.
 */

/** One host-mediated network request declared by a connector implementation. */
export interface ConnectorRequest {
  url: string;
  headers?: Record<string, string>;
  contentTypes?: readonly string[];
}

/** One draft entity extracted from a connector response. */
export interface ConnectorDraft {
  fields: Record<string, unknown>;
  content: string;
}

/** A compiled-in first-party connector implementation. */
export interface ConnectorDef {
  id: string;
  version: string;
  allowedHosts: readonly string[];
  inputs: readonly string[];
  draftFields: readonly string[];
  /** True when profile templates may expose this connector as user-facing. */
  templateInstallable: boolean;
  minRequestIntervalMs?: number;
  /** True when the host must refuse before fetch unless project config supplies contactEmail. */
  requiresContactEmail?: boolean;
  buildRequest(inputs: Record<string, string>): ConnectorRequest;
  parse(body: string, inputs: Record<string, string>): ConnectorDraft[];
  canonicalSourceId(inputs: Record<string, string>): string;
}

/** Pure-data profile binding from a connector output to one entity type. */
export interface ConnectorBindingDef {
  entityType: string;
  fields: Record<string, string>;
  contentField?: string;
}

/** Review-candidate provenance for connector-fetched drafts. */
export interface ConnectorProvenance {
  connectorId: string;
  connectorVersion: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  draftContentHash: string;
  idempotencyKey: string;
}

/** Durable connector-origin block carried in approved page frontmatter. */
export interface DurableConnectorBlock {
  connectorId: string;
  connectorVersion: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  idempotencyKey: string;
  externalFields: string[];
}
