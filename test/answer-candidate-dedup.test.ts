/**
 * Both staging orders preserve answer proposal identity and exact file bytes.
 * Generic import canonicalization remains scoped to generic candidates.
 */
import { expect, it } from "vitest";
import { readFile } from "fs/promises";
import { writeCandidate, writeFreshCandidate, listCandidates } from "../src/compiler/candidates.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { answerDraft, candidateFile } from "./fixtures/answer-candidate.js";

const root = useTempRoot();

it.each([true, false])("isolates generic and answer identities with generic-first=%s", async (genericFirst) => {
  const { candidateKind: _kind, citationManifest: _manifest, ...generic } = answerDraft();
  const first = genericFirst ? await writeCandidate(root.dir, generic) : undefined;
  const answer = await writeCandidate(root.dir, answerDraft());
  const bytes = await readFile(candidateFile(root.dir, answer.id), "utf8");
  const imported = await writeCandidate(root.dir, { ...generic, body: "Imported", reviewMode: "imported" });
  expect(imported.id).not.toBe(answer.id);
  if (first) expect(imported.id).toBe(first.id);
  const repeated = await writeCandidate(root.dir, answerDraft());
  expect(repeated.id).not.toBe(answer.id);
  const extra = await writeFreshCandidate(root.dir, generic);
  const canonical = await writeCandidate(root.dir, { ...generic, body: "Latest" });
  expect(canonical.id).toBe(imported.id);
  expect(await readFile(candidateFile(root.dir, answer.id), "utf8")).toBe(bytes);
  await expect(readFile(candidateFile(root.dir, extra.id))).rejects.toMatchObject({ code: "ENOENT" });
  const all = await listCandidates(root.dir);
  expect(all.map(c => c.id).sort()).toEqual([answer.id, repeated.id, imported.id].sort());
  expect(all.every(c => typeof c.generatedAt === "string")).toBe(true);
});
