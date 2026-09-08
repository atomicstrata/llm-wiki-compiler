/**
 * Approval must retry links deferred while their only matching target was held.
 * Uses the real candidate journal, approval command, and wiki files; only the
 * external embedding backend is replaced to keep the test offline.
 */
import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeCandidate } from "../src/compiler/candidates.js";
import { repairLinks } from "../src/compiler/link-repair.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import * as embeddings from "../src/utils/embeddings.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const ctx = useTempRoot();

it("repairs a deferred prefix when its candidate becomes live", async () => {
  const page = path.join(ctx.dir, "wiki/concepts/deployment.md");
  await writeFile(page, "---\ntitle: Deployment\n---\n\nUses [[Argo CD]].\n");
  const candidate = await writeCandidate(ctx.dir, {
    title: "Ownership", slug: "argo-cd-ownership", summary: "Details", sources: [],
    body: "---\ntitle: Ownership\nsummary: Details\nsources: []\n---\n\nOwnership details.\n",
  });
  expect(await repairLinks(ctx.dir)).toEqual([]);
  vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({ embedded: [], eligible: [] });
  await reviewApproveCommand(candidate.id);
  expect(await readFile(page, "utf8")).toContain("[[argo-cd-ownership|Argo CD]]");
});
