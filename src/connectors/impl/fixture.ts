/**
 * @file src/connectors/impl/fixture.ts
 * @description Offline first-party connector used by binding and substrate tests.
 */
import type { ConnectorDef } from "../types.js";

/** Deterministic connector used by local tests; it never performs I/O itself. */
export const fixtureConnector: ConnectorDef = {
  id: "fixture",
  version: "1",
  allowedHosts: ["fixture.local"],
  inputs: ["id"],
  draftFields: ["headline", "stage", "body"],
  templateInstallable: false,
  minRequestIntervalMs: 0,
  buildRequest: (inputs) => ({
    url: `https://fixture.local/${encodeURIComponent(inputs.id ?? "")}`,
    contentTypes: ["application/json"],
  }),
  canonicalSourceId: (inputs) => String(inputs.id ?? ""),
  parse: (_body, inputs) => [{
    fields: {
      headline: inputs.variant === "changed" ? "Changed story" : "Fixture story",
      stage: "draft",
      body: inputs.variant === "changed" ? "Changed body field prose" : "Fixture body field prose",
    },
    content: inputs.variant === "changed" ? "Changed connector body" : "Fixture connector body",
  }],
};
