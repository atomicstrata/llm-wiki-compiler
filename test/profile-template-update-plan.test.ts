/**
 * @file test/profile-template-update-plan.test.ts
 * @description Proves update planning is read-only and corpus-wide.
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProfilePack } from "../src/profile/types.js";
import type { ProfileTemplatePackage } from "../src/profile/templates/types.js";
import { planTemplateUpdate } from "../src/profile/templates/update.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

describe("planTemplateUpdate", () => {
  it("accepts an unchanged profile with a valid live page and writes nothing", async () => {
    const root = await seededRoot("update-plan-clean");
    const profile = baseProfile();
    const before = await readFile(path.join(root, "wiki/items/one.md"), "utf8");
    const plan = await planTemplateUpdate(root, profile, pkg(profile, "1.0.0"), pkg(profile, "1.1.0"));
    expect(plan).toMatchObject({ authority: "advisory", compatible: true, reasons: [] });
    expect(await readFile(path.join(root, "wiki/items/one.md"), "utf8")).toBe(before);
  });

  it("refuses active-profile drift even when the candidate is otherwise safe", async () => {
    const root = await seededRoot("update-plan-drift");
    const base = baseProfile();
    const active = { ...base, displayName: "Locally changed" };
    const plan = await planTemplateUpdate(root, active, pkg(base, "1.0.0"), pkg(active, "1.1.0"));
    expect(plan.compatible).toBe(false);
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "drift" }));
  });

  it("refuses template, publisher, source, and profile identity substitution", async () => {
    const root = await seededRoot("update-plan-identity");
    const profile = baseProfile();
    const base = pkg(profile, "1.0.0");
    await expect(planTemplateUpdate(root, profile, base, { ...pkg(profile, "1.1.0"), templateId: "other" }))
      .rejects.toThrow(/template identity/);
    await expect(planTemplateUpdate(root, profile, base, { ...pkg(profile, "1.1.0"), publisher: "other" }))
      .rejects.toThrow(/publisher identity/);
    await expect(planTemplateUpdate(root, profile, base, { ...pkg(profile, "1.1.0"), sourceType: "remote" }))
      .rejects.toThrow(/source identity/);
    const otherProfile = { ...profile, profileId: "other" };
    await expect(planTemplateUpdate(root, profile, base, pkg(otherProfile, "1.1.0"))).rejects.toThrow(/profile identity/);
  });

  it("refuses a page orphaned by removing its entity type", async () => {
    const root = await seededRoot("update-plan-orphan");
    const base = baseProfile();
    const candidate = { ...base, entities: { notes: { directory: "wiki/notes" } } };
    const plan = await planTemplateUpdate(root, base, pkg(base, "1.0.0"), pkg(candidate, "2.0.0"));
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "page" }));
  });

  it("refuses a newly required field missing from an existing page", async () => {
    const root = await seededRoot("update-plan-field");
    const base = baseProfile();
    const candidate = baseProfile(true);
    const plan = await planTemplateUpdate(root, base, pkg(base, "1.0.0"), pkg(candidate, "1.1.0"));
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "lint", message: expect.stringMatching(/field-violation/) }));
  });

  it("refuses pending candidate files without trusting their contents", async () => {
    const root = await seededRoot("update-plan-candidate");
    await mkdir(path.join(root, ".llmwiki/candidates"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki/candidates/pending.json"), "{broken", "utf8");
    const plan = await planBaseUpdate(root);
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "candidate" }));
  });

  it("refuses when archived candidate history is unreadable", async () => {
    const root = await seededRoot("update-plan-archive-fault");
    await seedCandidateArchive(root, "archive", "not a directory");
    const plan = await planBaseUpdate(root);
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "store", message: expect.stringMatching(/archive/) }));
  });

  it("refuses malformed archived candidates and unexpected workflow entries", async () => {
    const root = await seededRoot("update-plan-history-records");
    await seedCandidateArchive(root, "archive/bad.json", "{}");
    await mkdir(path.join(root, ".llmwiki/workflows/runs"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki/workflows/runs/foreign.txt"), "unknown", "utf8");
    const plan = await planBaseUpdate(root);
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "store", message: expect.stringMatching(/candidate.*malformed/) }));
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "store", message: expect.stringMatching(/workflow.*unexpected/) }));
  });

  it("refuses a symlinked archived candidate without reading its target", async () => {
    const root = await seededRoot("update-plan-archive-symlink");
    const outside = path.join(await makeTempRoot("update-plan-archive-outside"), "secret.json");
    await writeFile(outside, JSON.stringify({ id: "leak", title: "Leak", slug: "leak", body: "secret", sources: [] }), "utf8");
    await mkdir(path.join(root, ".llmwiki/candidates/archive"), { recursive: true });
    await symlink(outside, path.join(root, ".llmwiki/candidates/archive/leak.json"));
    const plan = await planBaseUpdate(root);
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "store", message: expect.stringMatching(/unexpected entry/) }));
    expect(JSON.stringify(plan)).not.toContain("secret");
  });

  it("refuses artifact contract changes while artifact files exist", async () => {
    const root = await seededRoot("update-plan-artifacts");
    await mkdir(path.join(root, "artifacts/result/run-1"), { recursive: true });
    await writeFile(path.join(root, "artifacts/result/run-1/result.json"), "{}", "utf8");
    const active = profileWithArtifact("result.json");
    const candidate = profileWithArtifact("result.txt");
    const plan = await planTemplateUpdate(root, active, pkg(active, "1.0.0"), pkg(candidate, "1.1.0"));
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "artifact" }));
  });

  it("refuses an unhealthy unreferenced artifact when contracts are unchanged", async () => {
    const root = await seededRoot("update-plan-unreferenced-artifact");
    await mkdir(path.join(root, "artifacts/result/run-1"), { recursive: true });
    await writeFile(path.join(root, "artifacts/result/run-1/result.json"), "{}", "utf8");
    await writeFile(path.join(root, "artifacts/result/run-1/result.json.manifest.json"), "{broken", "utf8");
    const profile = profileWithArtifact("result.json");
    const plan = await planTemplateUpdate(root, profile, pkg(profile, "1.0.0"), pkg(profile, "1.1.0"));
    expect(plan.reasons).toContainEqual(expect.objectContaining({ kind: "artifact", message: expect.stringMatching(/manifest is malformed/) }));
  });
});

async function seededRoot(name: string): Promise<string> {
  const root = await makeTempRoot(name);
  await mkdir(path.join(root, "wiki/items"), { recursive: true });
  await writeFile(path.join(root, "wiki/items/one.md"), "---\ntitle: One\n---\n\nUseful body.\n", "utf8");
  return root;
}

function baseProfile(requirePriority = false): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "team",
    displayName: "Team",
    entities: {
      items: {
        directory: "wiki/items",
        titleField: "title",
        fields: {
          title: { type: "string", required: true },
          ...(requirePriority ? { priority: { type: "string", required: true } } : {}),
        },
      },
    },
  };
}

function pkg(profile: ProfilePack, version: string): ProfileTemplatePackage {
  return {
    schemaVersion: 1, templateId: "team", version, displayName: "Team",
    publisher: "example", sourceType: "local", license: "MIT", minLlmwikiVersion: "1.0.0", profile,
  };
}

function profileWithArtifact(fileName: string): ProfilePack {
  return {
    ...baseProfile(),
    artifacts: {
      result: { contentKind: fileName.endsWith(".json") ? "json" : "text", fileName, maxBytes: 1024 },
    },
  };
}

async function seedCandidateArchive(root: string, relative: string, body: string): Promise<void> {
  const target = path.join(root, ".llmwiki/candidates", relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body, "utf8");
}

async function planBaseUpdate(root: string) {
  const profile = baseProfile();
  return planTemplateUpdate(root, profile, pkg(profile, "1.0.0"), pkg(profile, "1.1.0"));
}
