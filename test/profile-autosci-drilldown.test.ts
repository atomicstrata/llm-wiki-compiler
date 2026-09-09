/** AutoSci links must be declarative and leave every prior release unchanged. */
import { describe, it, expect } from "vitest";
import { getBuiltinTemplate, getBuiltinTemplateRelease } from "../src/profile/templates/registry.js";

describe("AutoSci drillable links", () => {
  it("declares optional output/foundation locators and artifact links", () => {
    const profile = getBuiltinTemplate("autosci")!.profile;
    for (const type of ["foundations", "research-outputs"]) {
      expect(profile.entities[type].fields?.locator).toMatchObject({ type: "string", format: "url" });
      expect(profile.entities[type].fields?.artifact).toMatchObject({ type: "artifactRef" });
      expect(profile.entities[type].fields?.artifact.required).not.toBe(true);
    }
    expect(profile.relations?.reviews).toMatchObject({ from: ["reviews"], to: ["manuscripts"] });
    expect(profile.relations?.authored.from).toEqual(["people"]);
    expect(profile.relations?.["contributed-to"].from).toEqual(["people"]);
  });
  it("retains the format-only release without retroactive link declarations", () => {
    const previous = getBuiltinTemplateRelease("autosci", "0.3.0", "atomicstrata")!;
    expect(previous).toBeDefined();
    expect(previous.profile.entities.foundations.fields).not.toHaveProperty("locator");
    expect(previous.profile.relations).not.toHaveProperty("reviews");
  });
});
