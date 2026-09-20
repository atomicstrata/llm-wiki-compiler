/**
 * Ordinary default candidates keep pending chains and production prefix repair;
 * only genuinely broken links refuse. Typed and unavailable policy stay separate.
 */
import { expect, it, vi } from "vitest";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import approve from "../src/commands/review-approve.js";
import { usePublicationRoot, generic, candidateBytes, retained, expectApprovalRefused } from "./fixtures/publication-review.js";
import { writeCandidate } from "../src/compiler/candidates.js";
import { candidateFile } from "./fixtures/answer-candidate.js";
import { SAMPLE_PROFILE } from "./fixtures/profile-fixtures.js";
import * as planner from "../src/trust/planner.js";

const root = usePublicationRoot();
it("imported generic query citing pending candidate approves with byte-identical content", async () => {
  const body = "---\ntitle: Imported\n---\nUses [[beta]].\n";
  const candidate = await writeCandidate(root.dir, { title: "Imported", slug: "imported", summary: "s", sources: ["okf:b"],
    body, targetDirectory: "queries", reviewMode: "imported", heldReasons: [{ code: "imported-okf" }], okfPath: "queries/imported.md" });
  await approve(candidate.id);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(root.dir, "wiki/queries/imported.md"), "utf8")).toBe(body);
});

it("allows unique retained-prefix repair and preserves the generic repair tail", async () => {
  await retained(root.dir, "argo-cd-ownership");
  const candidate = await generic(root.dir, "deployment", "Uses [[Argo CD]].");
  await approve(candidate.id);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(root.dir, "wiki/concepts/deployment.md"), "utf8"))
    .toContain("[[argo-cd-ownership|Argo CD]]");
});

it("preserves generic outbound resolution of plain concept-title mentions", async () => {
  await retained(root.dir, "graph-theory");
  const candidate = await generic(root.dir, "networks", "Networks use graph-theory ideas.");
  await approve(candidate.id);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(root.dir, "wiki/concepts/networks.md"), "utf8"))
    .toContain("[[graph-theory|graph-theory]]");
});

it.each(["ambiguous", "missing"])("refuses genuinely broken %s target without changing candidate", async (kind) => {
  if (kind === "ambiguous") {
    await retained(root.dir, "argo-cd-ownership");
    await generic(root.dir, "argo-cd-deployments", "Pending");
  }
  const candidate = await generic(root.dir, "deployment", "Uses [[Argo CD]].");
  const before = await candidateBytes(root.dir, candidate.id);
  await expectApprovalRefused(root.dir, candidate, before);
});

it("refuses a broken citation when a corrupted record names an unknown target directory", async () => {
  // Admission does not validate `targetDirectory`, and approval routes any value other
  // than "queries" into wiki/concepts, so the citation check must run for it too.
  const candidate = await generic(root.dir, "deployment", "Uses [[Missing]].");
  const file = candidateFile(root.dir, candidate.id);
  const corrupted = JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), targetDirectory: "elsewhere" });
  await writeFile(file, corrupted);
  await expectApprovalRefused(root.dir, candidate, corrupted);
});

it("warns and preserves generic approval when the new check is unavailable", async () => {
  const candidate = await generic(root.dir, "imported", "[[Missing]]", true);
  await chmod(path.join(root.dir, "wiki/concepts/alpha.md"), 0o000);
  await approve(candidate.id);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(root.dir, "wiki/queries/imported.md"), "utf8")).toBe(candidate.body);
  expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("citation check unavailable");
});

it("leaves typed candidates on their existing policy despite broken default wikilinks", async () => {
  await writeFile(path.join(root.dir, ".llmwiki/profile.json"), JSON.stringify(SAMPLE_PROFILE));
  const candidate = await writeCandidate(root.dir, { title: "Typed", slug: "typed", summary: "s", sources: [],
    targetEntityType: "notes", body: "---\ntitle: Typed\n---\n[[missing]]\n" });
  await approve(candidate.id);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(root.dir, "wiki/notes/typed.md"), "utf8")).toContain("[[missing]]");
});

it("does not catch planner failure as generic citation unavailability", async () => {
  const candidate = await generic(root.dir, "valid", "[[Alpha]]");
  const error = new Error("planner failed");
  vi.spyOn(planner, "planPageMutation").mockRejectedValueOnce(error);
  await expect(approve(candidate.id)).rejects.toBe(error);
  expect(await candidateBytes(root.dir, candidate.id)).toContain(candidate.id);
});
