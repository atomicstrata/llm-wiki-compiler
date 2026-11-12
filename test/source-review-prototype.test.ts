/**
 * Focused disk-backed witnesses for the internal source-review prototype.
 * Synthetic proposals prove wiring and invalidation, not model quality.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFile, writeFile, rm, unlink, symlink, mkdir } from "node:fs/promises";
import path from "node:path";
import { createDemo } from "./fixtures/source-review-project.js";
import { collectSourceReview } from "../src/viewer/source-review/report.js";

const roots: string[] = [];
/** Keep cleanup constrained to freshly allocated demo roots. */
async function fixture() { const root = await createDemo(); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("source-change review prototype", () => {
  it("uses the actual file identity when a proposal borrows another proposal ID", async () => {
    const root = await fixture();
    const directory = path.join(root, ".llmwiki/candidates");
    const original = JSON.parse(await readFile(path.join(directory, "timeout-proposal.json"), "utf8"));
    await writeFile(path.join(directory, "impostor.json"), JSON.stringify({ ...original, body: "Different body" }));
    const report = await collectSourceReview(root);
    expect(report.pages[0].candidates.find(candidate => candidate.body === "Different body")?.id).toBe("impostor");
    expect(report.pages[0].candidates.find(candidate => candidate.id === "timeout-proposal")?.body).toBe(original.body);
  });
  it("projects a nested source update and retains its unchanged contributor without writes", async () => {
    const root = await fixture();
    const state = await readFile(path.join(root, ".llmwiki/state.json"), "utf8");
    const report = await collectSourceReview(root);
    expect(report.stateStatus).toBe("ok");
    expect(report.pages[0].owners.map(owner => owner.status)).toEqual(["changed", "unchanged"]);
    expect(report.pages[0].candidates[0].checks).toEqual({ target: "matches", sources: "matches" });
    expect(report.pages[0].excerpts[0].text).toContain("1  Requests time out after 60 seconds");
    expect(report.pages[0].current).toContain("30 seconds");
    expect(report.pages[0].candidates[0].body).toContain("60 seconds");
    expect(await readFile(path.join(root, ".llmwiki/state.json"), "utf8")).toBe(state);
  });

  it("recomputes source and target bindings rather than keeping an old good result", async () => {
    const root = await fixture();
    const before = await collectSourceReview(root);
    await writeFile(path.join(root, "sources/api/timeouts.md"), "Now 90 seconds");
    await writeFile(path.join(root, "wiki/concepts/request-timeouts.md"), "Human correction");
    const after = await collectSourceReview(root);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.pages[0].candidates[0].checks).toEqual({ target: "changed or unreadable", sources: "changed or unavailable" });
  });

  it("shows partial contributor loss without claiming the entire page has no evidence", async () => {
    const root = await fixture();
    await unlink(path.join(root, "sources/api/timeouts.md"));
    const { pages } = await collectSourceReview(root);
    expect(pages[0].impact).toBe("Source update needs review");
    expect(pages[0].owners.map(owner => owner.status)).toEqual(["unavailable", "unchanged"]);
  });

  it("does not treat absent legacy bindings as checked or corrupt state as fresh", async () => {
    const root = await fixture();
    const file = path.join(root, ".llmwiki/candidates/timeout-proposal.json");
    const candidate = JSON.parse(await readFile(file, "utf8"));
    delete candidate.sourceStates; delete candidate.expectedTargetHash;
    await writeFile(file, JSON.stringify(candidate));
    await writeFile(path.join(root, ".llmwiki/state.json"), "invalid");
    const report = await collectSourceReview(root);
    expect(report.stateStatus).toBe("corrupt");
    expect(report.pages[0].candidates[0].checks).toEqual({ target: "not recorded", sources: "not recorded" });
  });

  it("refuses a page symlink outside the concept directory", async () => {
    const root = await fixture();
    const file = path.join(root, "wiki/concepts/request-timeouts.md");
    await unlink(file);
    await symlink(path.join(root, ".llmwiki/state.json"), file);
    const report = await collectSourceReview(root);
    expect(report.pages[0].current).toBeNull();
    expect(report.pages[0].candidates[0].checks.target).toBe("changed or unreadable");
  });

  it("isolates a source read failure rather than losing the entire comparison", async () => {
    const root = await fixture();
    const source = path.join(root, "sources/retry.md");
    await unlink(source); await mkdir(source);
    const report = await collectSourceReview(root);
    expect(report.pages[0].owners[1].status).toBe("unavailable");
    expect(report.pages[0].current).toContain("30 seconds");
  });

  it("detects changes beyond the display limit without inventing a target binding", async () => {
    const root = await fixture();
    const candidatePath = path.join(root, ".llmwiki/candidates/timeout-proposal.json");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    delete candidate.expectedTargetHash;
    await writeFile(candidatePath, JSON.stringify(candidate));
    const page = path.join(root, "wiki/concepts/request-timeouts.md");
    await writeFile(page, "x".repeat(80_001));
    const before = await collectSourceReview(root);
    await writeFile(page, "x".repeat(80_000) + "y");
    const after = await collectSourceReview(root);
    expect(before.pages[0].current).toBe(after.pages[0].current);
    expect(before.fingerprint).not.toBe(after.fingerprint);
    expect(after.pages[0].candidates[0].checks.target).toBe("not recorded");
  });

  it("reports expected absence and refuses contradictory target expectations", async () => {
    const root = await fixture();
    const file = path.join(root, ".llmwiki/candidates/timeout-proposal.json");
    const candidate = JSON.parse(await readFile(file, "utf8"));
    candidate.expectTargetAbsent = true;
    await writeFile(file, JSON.stringify(candidate));
    expect((await collectSourceReview(root)).pages[0].candidates[0].checks.target).toBe("invalid expectations");
    delete candidate.expectedTargetHash;
    await writeFile(file, JSON.stringify(candidate));
    expect((await collectSourceReview(root)).pages[0].candidates[0].checks.target).toBe("expected absent; present or unreadable");
    await unlink(path.join(root, "wiki/concepts/request-timeouts.md"));
    expect((await collectSourceReview(root)).pages[0].candidates[0].checks.target).toBe("expected absence observed");
  });
});
