/**
 * @file test/connectors/registry.test.ts
 * @description Product-discovery boundaries for compiled-in connectors.
 */
import { describe, expect, it } from "vitest";
import { allConnectors, discoverableConnectors } from "../../src/connectors/registry.js";

describe("connector registry", () => {
  it("keeps test connectors registered without exposing them to users", () => {
    expect(allConnectors().map((connector) => connector.id)).toContain("fixture");
    expect(discoverableConnectors().map((connector) => connector.id)).toEqual(["crossref"]);
  });
});
