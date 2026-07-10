/**
 * @file src/export/connector-content.ts
 * @description Connector-origin text rendering helpers for agent-facing export formats.
 */
import { fenceUntrustedConnectorText } from "../connectors/fence.js";
import type { ExportPage } from "./types.js";

/**
 * Fence full page prose when it came from a connector.
 *
 * JSON export carries raw body plus explicit `connectorOrigin` metadata; text
 * exports are flattened for agents, so the trust label must travel inline with
 * the bytes.
 */
export function exportBodyText(page: ExportPage): string {
  return page.connectorOrigin
    ? fenceUntrustedConnectorText(page.body, page.connectorOrigin)
    : page.body;
}

/** Fence an exported frontmatter-derived field if the connector declared it external. */
export function exportFieldText(page: ExportPage, field: string, value: string): string {
  return page.connectorOrigin?.externalFields.includes(field)
    ? fenceUntrustedConnectorText(value, page.connectorOrigin)
    : value;
}

/** Return a page clone whose body is the text-export-safe connector body. */
export function withExportBody(page: ExportPage): ExportPage {
  const body = exportBodyText(page);
  return body === page.body ? page : { ...page, body };
}
