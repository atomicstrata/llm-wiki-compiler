/**
 * @file src/connectors/registry.ts
 * @description Static first-party connector registry.
 */
import { fixtureConnector } from "./impl/fixture.js";
import { crossrefConnector } from "./impl/crossref.js";
import type { ConnectorDef } from "./types.js";

/** Admit one compiled definition by copying and freezing all mutable metadata. */
function admitConnectorDefinition(definition: ConnectorDef): ConnectorDef {
  return Object.freeze({
    ...definition,
    allowedHosts: Object.freeze([...definition.allowedHosts]),
    inputs: Object.freeze([...definition.inputs]),
    draftFields: Object.freeze([...definition.draftFields]),
    buildRequest: definition.buildRequest,
    parse: definition.parse,
    canonicalSourceId: definition.canonicalSourceId,
  });
}

const CONNECTORS: readonly ConnectorDef[] = Object.freeze(
  [crossrefConnector, fixtureConnector].map(admitConnectorDefinition),
);

/** List every compiled-in first-party connector. */
export function allConnectors(): readonly ConnectorDef[] {
  return Object.freeze([...CONNECTORS]);
}

/** List connectors whose definitions explicitly permit user-facing templates. */
export function discoverableConnectors(): readonly ConnectorDef[] {
  return Object.freeze(CONNECTORS.filter((connector) => connector.templateInstallable));
}

/** Resolve one compiled-in connector definition by id. */
export function getConnectorDef(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((def) => def.id === id);
}
