/**
 * @file test/profile-template-corpus.test.ts
 * @description Tests for the conservative typed-corpus-empty probe used by template init.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { artifactPaths, hashArtifactBody, writeArtifactFiles, type ArtifactManifest } from "../src/artifacts/store.js";
import { appendEvent } from "../src/events/store.js";
import { loadProfile, ProfileLoadError } from "../src/profile/load.js";
import { AUTOSCI_TEMPLATE } from "../src/profile/templates/builtin/autosci.js";
import { NEWSROOM_TEMPLATE } from "../src/profile/templates/builtin/newsroom.js";
import { isTypedCorpusEmpty } from "../src/profile/templates/corpus.js";
import type { EntityId } from "../src/profile/types.js";
import { appendRelation } from "../src/relations/store.js";
import { stageEntityPage } from "../src/trust/staging.js";
import { EVENTS_FILE, PROFILE_FILE, RELATIONS_FILE } from "../src/utils/constants.js";
import { makeTempRoot } from "./fixtures/temp-root.js";

async function writeActiveProfile(root: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), `${JSON.stringify(AUTOSCI_TEMPLATE.profile)}\n`, "utf8");
}

async function probe(root: string, target = AUTOSCI_TEMPLATE.profile) {
  return isTypedCorpusEmpty(root, await loadProfile(root), target);
}

describe("isTypedCorpusEmpty", () => {
  it("treats a default project with no typed stores as empty", async () => {
    const root = await makeTempRoot("template-corpus-empty");
    await expect(probe(root)).resolves.toEqual({ empty: true, reasons: [] });
  });

  it("counts default concept pages so template init cannot orphan a populated default wiki", async () => {
    const root = await makeTempRoot("template-corpus-default-concept");
    await writeFile(path.join(root, "wiki/concepts/rag.md"), "# RAG\n", "utf8");

    const result = await probe(root);

    expect(result.empty).toBe(false);
    expect(result.reasons).toContain("typed entity pages exist under wiki/concepts");
  });

  it("counts typed entity pages under the active profile", async () => {
    const root = await makeTempRoot("template-corpus-page");
    await writeActiveProfile(root);
    await mkdir(path.join(root, "wiki/papers"), { recursive: true });
    await writeFile(path.join(root, "wiki/papers/bert.md"), "---\ntitle: BERT\nauthors: [Devlin]\nstage: imported\n---\n\nBody", "utf8");

    const result = await probe(root, NEWSROOM_TEMPLATE.profile);

    expect(result.empty).toBe(false);
    expect(result.reasons).toContain("typed entity pages exist under wiki/papers");
  });

  it("counts stale pages under the incoming template profile directories", async () => {
    const root = await makeTempRoot("template-corpus-target-dir");
    await writeActiveProfile(root);
    await mkdir(path.join(root, "wiki/articles"), { recursive: true });
    await writeFile(path.join(root, "wiki/articles/story.md"), "---\nheadline: Story\nstage: draft\n---\n\nBody", "utf8");

    const result = await probe(root, NEWSROOM_TEMPLATE.profile);

    expect(result.empty).toBe(false);
    expect(result.reasons).toContain("typed entity pages exist under wiki/articles");
  });

  it("counts relation records and relation-store problems", async () => {
    const root = await makeTempRoot("template-corpus-rel");
    await appendRelation(root, AUTOSCI_TEMPLATE.profile, {
      type: "tests",
      from: "experiments/run-1" as EntityId,
      to: "ideas/idea-1" as EntityId,
    });
    const withRecord = await probe(root);
    expect(withRecord.reasons).toContain("relation store contains records");

    const broken = await makeTempRoot("template-corpus-relation-problem");
    await mkdir(path.dirname(path.join(broken, RELATIONS_FILE)), { recursive: true });
    await writeFile(path.join(broken, RELATIONS_FILE), "{\"kind\":\"relation-store-header\",\"schemaVersion\":1}\n{\"id\"", "utf8");
    const withProblem = await probe(broken);
    expect(withProblem.reasons).toContain("relation store has unresolved problems");
  });

  it("counts artifact files and unsafe artifact stores", async () => {
    const root = await makeTempRoot("template-corpus-artifact");
    const body = "{\"accuracy\":0.9}";
    const manifest: ArtifactManifest = {
      artifactType: "experiment-result",
      slug: "run-1",
      sha256: hashArtifactBody(body),
      bytes: Buffer.byteLength(body, "utf8"),
      contentKind: "json",
      writtenAt: new Date().toISOString(),
    };
    await writeArtifactFiles(root, artifactPaths(root, "experiment-result", "run-1", "result.json"), body, manifest);
    expect((await probe(root)).reasons).toContain("artifact store contains files");

    const escaped = await makeTempRoot("template-corpus-artifact-escape");
    const outside = path.join(escaped, "..", `outside-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(escaped, "artifacts"));
    expect((await probe(escaped)).reasons).toContain("artifact store is unreadable or unsafe");
  });

  it("counts workflow runs, pending candidates, and event records", async () => {
    const root = await makeTempRoot("template-corpus-stores");
    await writeActiveProfile(root);
    await mkdir(path.join(root, ".llmwiki/workflows/runs"), { recursive: true });
    await writeFile(path.join(root, ".llmwiki/workflows/runs/run-1.json"), "{}", "utf8");
    await stageEntityPage(root, {
      entityType: "papers",
      slug: "bert",
      body: "---\ntitle: BERT\nauthors: [Devlin]\nstage: imported\n---\n\nBody",
      profile: AUTOSCI_TEMPLATE.profile,
      existingStagedCount: 0,
    });
    await appendEvent(root, {
      type: "relation-create",
      origin: "cli",
      at: new Date().toISOString(),
      payload: { relationId: "rel-template-test", type: "tests", from: "experiments/run-1", to: "ideas/idea-1" },
    });

    const result = await probe(root, NEWSROOM_TEMPLATE.profile);

    expect(result.reasons).toContain("workflow runs exist");
    expect(result.reasons).toContain("pending review candidates exist");
    expect(result.reasons).toContain("event store contains records");
  });

  it("treats workflow store unavailability as unsafe", async () => {
    const root = await makeTempRoot("template-corpus-run-escape");
    const privateDir = path.join(root, ".llmwiki");
    const outside = path.join(root, "..", `workflow-outside-${Date.now()}`);
    await mkdir(path.join(outside, "runs"), { recursive: true });
    await mkdir(privateDir, { recursive: true });
    await symlink(outside, path.join(privateDir, "workflows"));

    const result = await probe(root);

    expect(result.reasons).toContain("workflow run store is unreadable or unsafe: escape");
  });

  it("treats event-store problems as unsafe", async () => {
    const root = await makeTempRoot("template-corpus-event-problem");
    await appendEvent(root, {
      type: "relation-create",
      origin: "cli",
      at: new Date().toISOString(),
      payload: { relationId: "rel-template-test", type: "tests", from: "experiments/run-1", to: "ideas/idea-1" },
    });
    await writeFile(path.join(root, EVENTS_FILE), "\n{\"torn\"", { flag: "a" });

    const result = await probe(root);

    expect(result.reasons).toContain("event store contains records");
    expect(result.reasons).toContain("event store has unresolved problems");
  });

  it("requires callers to refuse when the active profile is present but unloadable", async () => {
    const root = await makeTempRoot("template-corpus-broken-profile");
    await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
    await writeFile(path.join(root, PROFILE_FILE), "{broken", "utf8");

    await expect(loadProfile(root)).rejects.toBeInstanceOf(ProfileLoadError);
  });
});
