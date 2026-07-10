/**
 * @file src/connectors/registry.ts
 * @description Static first-party connector registry.
 */
import { fixtureConnector } from "./impl/fixture.js";
import { crossrefConnector } from "./impl/crossref.js";
import type { ConnectorDef } from "./types.js";

const CONNECTORS: ConnectorDef[] = [crossrefConnector, fixtureConnector];

/** List every compiled-in first-party connector. */
export function allConnectors(): readonly ConnectorDef[] {
  return [...CONNECTORS];
}

/** List connectors whose definitions explicitly permit user-facing templates. */
export function discoverableConnectors(): readonly ConnectorDef[] {
  return CONNECTORS.filter((connector) => connector.templateInstallable);
}

/** Resolve one compiled-in connector definition by id. */
export function getConnectorDef(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((def) => def.id === id);
}
