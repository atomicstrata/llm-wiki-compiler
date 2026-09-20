/**
 * Validated answers retain their proposals on refusal and require current
 * retained targets and profile eligibility, regardless of proposal observations.
 */
import { expect, it, vi } from "vitest";
import * as planner from "../src/trust/planner.js";
import { chmod, unlink } from "node:fs/promises";
import path from "node:path";
import approve from "../src/commands/review-approve.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { sha256Text } from "../src/connectors/hash.js";
import { replaceCandidate } from "./fixtures/answer-candidate.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { usePublicationRoot, propose, candidateBytes, retained, generic, expectApprovalRefused, approvePage, expectApprovedAndCleared } from "./fixtures/publication-review.js";

const root = usePublicationRoot();
it("refuses pending answer, legitimately approves target, then publishes and clears only the answer", async () => {
  const target = await generic(root.dir, "future", "Future body.");
  const candidate = await propose(root.dir, "[[future]]");
  const before = await candidateBytes(root.dir, candidate.id);
  await expectApprovalRefused(root.dir, candidate, before);
  process.exitCode = 0;
  await approve(target.id);
  expect(process.exitCode).toBe(0);
  await expectApprovedAndCleared(root.dir, candidate);
});

it.each(["delete", "unavailable"])("fresh approval refuses after %s and retains candidate bytes", async (change) => {
  const candidate = await propose(root.dir);
  const before = await candidateBytes(root.dir, candidate.id);
  const target = path.join(root.dir, "wiki/concepts/alpha.md");
  if (change === "delete") await unlink(target);
  if (change === "unavailable") await chmod(target, 0o000);
  await expectApprovalRefused(root.dir, candidate, before);
});

it("stages and approves in a profile-enabled project through the trust-routed planner", async () => {
  await buildResearchLiteProject(root.dir);
  await expectApprovedAndCleared(root.dir, await propose(root.dir));
});

it("revalidates against the current profile when it changes after staging", async () => {
  const candidate = await propose(root.dir);
  await buildResearchLiteProject(root.dir);
  expect(await approvePage(root.dir, candidate)).toBe(candidate.body);
});

it("retains the candidate and writes nothing when the planner refuses the write", async () => {
  const candidate = await propose(root.dir);
  const before = await candidateBytes(root.dir, candidate.id);
  vi.spyOn(planner, "planPageMutation").mockResolvedValueOnce({ planned: [] } as never);
  await expectApprovalRefused(root.dir, candidate, before);
});

it("uses a currently retargeted alias instead of freezing the proposal identity", async () => {
  await retained(root.dir, "first", ["Shared"]);
  const candidate = await propose(root.dir, "[[Shared]]");
  await retained(root.dir, "first");
  await retained(root.dir, "second", ["Shared"]);
  expect(await approvePage(root.dir, candidate)).toBe(candidate.body);
});

it.each([false, true])("refuses edited body even with forged digest = %s", async (forgeDigest) => {
  const candidate = await propose(root.dir);
  candidate.body += "[[gone]]\n";
  if (forgeDigest) candidate.citationManifest!.bodyDigest = sha256Text(parseFrontmatter(candidate.body).body);
  const before = await replaceCandidate(root.dir, candidate.id, candidate);
  await expectApprovalRefused(root.dir, candidate, before);
  const message = (console.log as import("vitest").Mock).mock.calls.flat().join(" ");
  expect(message).toContain(forgeDigest ? "broken" : "candidate-edited");
});

it.each(["orphan", "invalid-kind"])("admission refuses %s manifest metadata before approval policy", async (kind) => {
  const candidate = await propose(root.dir);
  const raw = { ...candidate };
  if (kind === "orphan") delete raw.candidateKind;
  else Object.assign(raw, { candidateKind: { name: "unsupported", version: 2 } });
  const before = await replaceCandidate(root.dir, candidate.id, raw);
  await expectApprovalRefused(root.dir, candidate, before);
  expect((console.log as import("vitest").Mock).mock.calls.flat().join(" ")).toContain("InvalidCandidateMetadata");
});
