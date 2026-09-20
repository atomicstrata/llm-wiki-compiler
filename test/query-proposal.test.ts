/**
 * Reviewed query saves stage fresh canonical candidates under the same profile
 * gate, without publishing pages or refreshing retrieval artifacts.
 */
import { expect, it, vi } from "vitest";
import { chmod, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { maybeSaveQueryPage } from "../src/commands/query-publication.js";
import { generateAnswer } from "../src/commands/query.js";
import { updateEmbeddingsLockedCore } from "../src/utils/embeddings.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { sha256Text } from "../src/connectors/hash.js";
import { usePublicationRoot, propose, candidateBytes } from "./fixtures/publication-review.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { callClaude } from "../src/utils/llm.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

const root = usePublicationRoot();
it("returns a candidate ID and preserved answer through generation without extra provider work", async () => {
  vi.mocked(callClaude).mockReset().mockImplementation(async options => options.tools
    ? JSON.stringify({ pages: ["concepts/alpha"], reasoning: "Selected alpha" }) : "[[beta]]");
  const result = await generateAnswer(root.dir, "Answer", { save: true, review: true });
  expect(result.answer).toBe("[[beta]]");
  expect(result.candidateId).toBeTypeOf("string");
  expect(result.saved).toBeUndefined();
  expect(result.publicationRefusal).toBeUndefined();
  expect(callClaude).toHaveBeenCalledTimes(2);
});
it("treats internal review without save as no publication request", async () => {
  await expect(maybeSaveQueryPage({ root: "/does-not-exist", question: "Answer", answer: "", save: false, review: true }))
    .resolves.toEqual({});
});
it("stages pending citations as separate forced-review answers with exact manifests", async () => {
  const before = await readFile(path.join(root.dir, "wiki/index.md"));
  const first = await propose(root.dir, "[[beta]]");
  const firstBytes = await candidateBytes(root.dir, first.id);
  const second = await propose(root.dir, "[[beta]]");
  expect(first.id).not.toBe(second.id);
  expect(await candidateBytes(root.dir, first.id)).toBe(firstBytes);
  expect(first).toMatchObject({ targetDirectory: "queries", sources: [], reviewMode: "forced",
    candidateKind: { name: "validated-answer", version: 1 }, citationManifest: {
      version: 1, bodyDigest: sha256Text(parseFrontmatter(first.body).body),
      citations: [{ target: "beta", status: "pending", candidateIds: ["pending-beta"] }],
    } });
  expect(first).not.toHaveProperty("sourceStates");
  expect(first).not.toHaveProperty("connectorProvenance");
  expect(await readdir(path.join(root.dir, "wiki/queries"))).toEqual([]);
  expect(await readFile(path.join(root.dir, "wiki/index.md"))).toEqual(before);
  expect(updateEmbeddingsLockedCore).not.toHaveBeenCalled();
});

it("stages in a profile-enabled project without publishing or refreshing", async () => {
  await buildResearchLiteProject(root.dir);
  const result = await maybeSaveQueryPage({ root: root.dir, question: "Answer", answer: "[[Alpha]]", save: true, review: true });
  expect(result.publicationRefusal).toBeUndefined();
  expect(result.candidateId).toBeTypeOf("string");
  expect(await readdir(path.join(root.dir, "wiki/queries"))).toEqual([]);
  expect(updateEmbeddingsLockedCore).not.toHaveBeenCalled();
});
it.each(["broken", "unavailable"])("refuses %s staging without adding candidates", async (code) => {
  if (code === "unavailable") await chmod(path.join(root.dir, "wiki/concepts/alpha.md"), 0o000);
  const before = await readdir(path.join(root.dir, ".llmwiki/candidates"));
  const result = await maybeSaveQueryPage({ root: root.dir, question: "Answer", answer: "[[gone]]", save: true, review: true });
  expect(result.publicationRefusal?.code).toBe(code);
  expect(result.candidateId).toBeUndefined();
  expect(await readdir(path.join(root.dir, ".llmwiki/candidates"))).toEqual(before);
  expect(await readdir(path.join(root.dir, "wiki/queries"))).toEqual([]);
  expect(updateEmbeddingsLockedCore).not.toHaveBeenCalled();
});
