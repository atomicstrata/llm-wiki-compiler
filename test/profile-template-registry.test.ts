/**
 * @file test/profile-template-registry.test.ts
 * @description Tests for profile template package validation and capability derivation.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConnectorDef } from "../src/connectors/registry.js";
import type { ProfilePack } from "../src/profile/types.js";
import { deriveTemplateCapabilities } from "../src/profile/templates/capabilities.js";
import { getBuiltinTemplate, listBuiltinTemplates, summaryFor } from "../src/profile/templates/registry.js";
import { TemplatePackageError, validateTemplatePackage } from "../src/profile/templates/validate.js";

const MINIMAL_PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "team",
  displayName: "Team",
  entities: { docs: { directory: "wiki/docs", fields: { title: { type: "string" } } } },
};

const PACKAGE = {
  schemaVersion: 1,
  templateId: "team",
  version: "0.1.0",
  displayName: "Team Template",
  publisher: "team",
  sourceType: "local",
  license: "MIT",
  minLlmwikiVersion: "0.1.0",
  profile: MINIMAL_PROFILE,
};

function validate(raw: unknown = PACKAGE, currentVersion = "0.11.0") {
  return validateTemplatePackage(raw, { currentVersion, sourceType: "local" });
}

describe("validateTemplatePackage", () => {
  it("accepts a minimal local template package", () => {
    const pkg = validate();
    expect(pkg.templateId).toBe("team");
    expect(pkg.profile.profileId).toBe("team");
  });

  it("rejects parallel trust and capability declarations", () => {
    expect(() => validate({ ...PACKAGE, trustLevel: "builtin" })).toThrow(TemplatePackageError);
    expect(() => validate({ ...PACKAGE, capabilities: ["connectors"] })).toThrow(TemplatePackageError);
  });

  it("rejects an unsupported minimum llmwiki version before install", () => {
    expect(() => validate({ ...PACKAGE, minLlmwikiVersion: "99.0.0" })).toThrow(/requires llmwiki >= 99\.0\.0/);
  });

  it("accepts build metadata on the running llmwiki version", () => {
    expect(() => validate(PACKAGE, "0.11.0+build.7")).not.toThrow();
  });

  it("accepts prerelease metadata on the running llmwiki version", () => {
    expect(() => validate(PACKAGE, "0.11.0-rc.1")).not.toThrow();
  });

  it("rejects a malformed template minimum version", () => {
    expect(() => validate({ ...PACKAGE, minLlmwikiVersion: "next" })).toThrow(/invalid template minLlmwikiVersion/i);
  });

  it("rejects a malformed template package version", () => {
    expect(() => validate({ ...PACKAGE, version: "next" })).toThrow(/invalid template version/i);
  });

  it("rejects sourceType self-attestation that does not match the caller context", () => {
    expect(() => validateTemplatePackage({ ...PACKAGE, sourceType: "builtin" }, { currentVersion: "0.11.0", sourceType: "local" })).toThrow(
      /template sourceType must be local for this install source/i,
    );
  });

  it("rejects executable or authority-bearing package keys", () => {
    for (const key of ["scripts", "postinstall", "commands", "mcpServers", "connectorImplementation"]) {
      expect(() => validate({ ...PACKAGE, [key]: {} })).toThrow(/unsupported template package field/i);
    }
  });

  it("rejects executable examples", () => {
    expect(() =>
      validate({ ...PACKAGE, examples: [{ id: "run", title: "Run", kind: "script", path: "scripts/run.sh" }] }),
    ).toThrow(/template example kind must be 'okf'/i);
  });

  it("rejects non-OKF example paths even when the kind claims okf", () => {
    expect(() => validate({ ...PACKAGE, examples: [{ id: "run", title: "Run", kind: "okf", path: "scripts/run.sh" }] })).toThrow(
      /example.path must point to an .okf bundle/i,
    );
  });

  it("rejects unsafe example paths even though examples are metadata-only in v0", () => {
    for (const path of ["/tmp/example.okf", "../example.okf", "examples/../example.okf", "examples\\example.okf"]) {
      expect(() => validate({ ...PACKAGE, examples: [{ id: "sample", title: "Sample", kind: "okf", path }] })).toThrow(
        /example.path must be a safe relative path/i,
      );
    }
  });

  it("rejects installable templates whose templateId and profileId differ", () => {
    const mismatched = {
      ...PACKAGE,
      templateId: "autosci",
      profile: { ...MINIMAL_PROFILE, profileId: "other" },
    };
    expect(() => validate(mismatched)).toThrow(/templateId must match profileId/i);
  });

  it("rejects test-only connector bindings in installable templates", () => {
    const withFixture = {
      ...PACKAGE,
      profile: {
        ...MINIMAL_PROFILE,
        entities: { docs: { directory: "wiki/docs", fields: { headline: { type: "string" } } } },
        connectors: { fixture: { entityType: "docs", fields: { headline: "headline" } } },
      },
    };
    expect(() => validate(withFixture)).toThrow(/not installable in templates/i);
  });
});

describe("deriveTemplateCapabilities", () => {
  it("derives capabilities from the profile instead of a manifest field", () => {
    const profile: ProfilePack = {
      ...MINIMAL_PROFILE,
      artifacts: {
        report: { fileName: "report.json", contentKind: "json", maxBytes: 4096 },
      },
      connectors: {
        crossref: { entityType: "docs", fields: { title: "title" } },
      },
      workflows: { "doc-flow": { stages: [{ id: "draft", reads: ["docs"], writes: ["docs"] }] } },
      workflowActions: {
        "doc-flow.start": {
          label: "Start ingest",
          workflow: "doc-flow",
          operation: "start",
          trustGate: "trust:input",
          permissions: { cli: "staged-write", sdk: "staged-write", mcp: "staged-write", viewer: "disabled" },
        },
      },
    };

    const validated = validate({ ...PACKAGE, profile }).profile;

    expect(deriveTemplateCapabilities(validated)).toMatchObject({
      entities: 1,
      relations: 0,
      workflows: 1,
      workflowActions: 1,
      artifacts: 1,
      connectors: ["crossref"],
    });
  });
});

describe("builtin template registry", () => {
  it("keeps template installability policy on connector definitions", () => {
    expect(getConnectorDef("crossref")).toMatchObject({ templateInstallable: true });
    expect(getConnectorDef("fixture")).toMatchObject({ templateInstallable: false });
  });

  it("lists default, autosci, and newsroom with derived capabilities", () => {
    const summaries = listBuiltinTemplates();
    expect(summaries.map((s) => s.templateId)).toEqual(["default", "autosci", "newsroom"]);
    expect(summaries.find((s) => s.templateId === "default")).toMatchObject({ installable: false });
    expect(summaries.find((s) => s.templateId === "autosci")).toMatchObject({
      profileId: "autosci",
      displayName: "AutoSci",
    });
    expect(summaries.find((s) => s.templateId === "autosci")?.capabilities).toMatchObject({
      entities: 12,
      relations: 12,
      workflows: 5,
      artifacts: 7,
      connectors: ["crossref"],
    });
    expect(summaries.find((s) => s.templateId === "newsroom")?.capabilities).toMatchObject({
      entities: 3,
      relations: 1,
      workflows: 1,
      artifacts: 0,
      connectors: [],
    });
  });

  it("validates shipped templates and reconciles only autosci's crossref connector", () => {
    const autosci = getBuiltinTemplate("autosci");
    const newsroom = getBuiltinTemplate("newsroom");
    for (const template of [autosci, newsroom]) {
      if (!template) throw new Error("expected shipped template to exist");
      expect(() => validateTemplatePackage(template, { currentVersion: "1.0.0", sourceType: "builtin" })).not.toThrow();
    }
    expect(autosci?.profile.profileId).toBe("autosci");
    expect(autosci?.profile.connectors).toEqual({
      crossref: {
        entityType: "papers",
        fields: { title: "title", doi: "doi", year: "year", authors: "authors", stage: "stage" },
        contentField: "abstract",
      },
    });
    expect(getConnectorDef("crossref")).toBeDefined();
    expect(newsroom?.profile.connectors).toBeUndefined();
  });

  it("builds installable summaries from shipped template packages", () => {
    const autosci = getBuiltinTemplate("autosci");
    if (!autosci) throw new Error("expected autosci template to exist");

    expect(summaryFor(autosci)).toMatchObject({
      templateId: "autosci",
      profileId: "autosci",
      installable: true,
      capabilities: { connectors: ["crossref"] },
    });
  });

  it("does not import shipped template data from test fixtures", async () => {
    const builtinRoot = path.resolve("src/profile/templates/builtin");
    const files = (await readdir(builtinRoot, { recursive: true }))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join(builtinRoot, name));
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("test/fixtures");
      expect(text).not.toContain("../fixtures");
    }
  });
});
