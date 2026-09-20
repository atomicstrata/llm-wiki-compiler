/**
 * Manifest admission tests for normalized PUB01 observations and exact shapes.
 * Audit metadata is structural here; fresh resolution belongs to publication.
 */
import { expect, it } from "vitest";
import { readCandidate, writeFreshCandidate } from "../src/compiler/candidates.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { answerDraft, replaceCandidate } from "./fixtures/answer-candidate.js";

const root = useTempRoot();

it.each([
  ["manifest version", { version: 2 }],
  ["uppercase digest", { bodyDigest: "A".repeat(64) }],
  ["short digest", { bodyDigest: "123" }],
  ["missing citations", { citations: undefined }],
  ["unknown status", { citations: [{ target: "x", status: "other" }] }],
  ["non-normalized target", { citations: [{ target: "Two Words", status: "broken" }] }],
  ["duplicate target", { citations: [{ target: "x", status: "broken" }, { target: "x", status: "broken" }] }],
  ["missing page identity", { citations: [{ target: "x", status: "resolved" }] }],
  ["typed page identity", { citations: [{ target: "x", status: "resolved", pageId: "papers/x" }] }],
  ["traversal page identity", { citations: [{ target: "x", status: "resolved", pageId: "queries/../x" }] }],
  ["empty pending identities", { citations: [{ target: "x", status: "pending", candidateIds: [] }] }],
  ["unsafe pending identity", { citations: [{ target: "x", status: "pending", candidateIds: ["../bad"] }] }],
  ["duplicate pending identity", { citations: [{ target: "x", status: "pending", candidateIds: ["a", "a"] }] }],
  ["unsorted pending identities", { citations: [{ target: "x", status: "pending", candidateIds: ["b", "a"] }] }],
  ["cross-status fields", { citations: [{ target: "x", status: "broken", pageId: "concepts/x" }] }],
])("refuses malformed observation metadata: %s", async (_name, fields) => {
  const candidate = await writeFreshCandidate(root.dir, answerDraft());
  await replaceCandidate(root.dir, candidate.id, { ...candidate,
    citationManifest: { ...answerDraft().citationManifest, ...fields } });
  expect(await readCandidate(root.dir, candidate.id)).toBeNull();
});

it("preserves all supported observations including the normalized empty broken target", async () => {
  const candidate = await writeFreshCandidate(root.dir, answerDraft());
  const citationManifest = { ...answerDraft().citationManifest, citations: [
    { target: "alias", status: "resolved", pageId: "queries/Raw Name" },
    { target: "pending", status: "pending", candidateIds: ["pending-01", "pending-02"] },
    { target: "", status: "broken" },
  ] };
  await replaceCandidate(root.dir, candidate.id, { ...candidate, citationManifest });
  expect((await readCandidate(root.dir, candidate.id))?.citationManifest).toEqual(citationManifest);
});
