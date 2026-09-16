/** Persistent quarantine diagnostics must reach real read surfaces without modifying retry state. */
import { readFile, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { collectStatus } from "../src/status/collect.js";
import { lint } from "../src/linter/index.js";
import { writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { QUARANTINED_EMBEDDINGS_FILE, PENDING_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const ctx = useCompileProject({ dirSuffix: "quarantine-surfaces" });
const QUARANTINED = "embeddings-refresh-quarantined";
const UNAVAILABLE = "embeddings-quarantine-unavailable";

/** Exercise both underlying pipelines, not a stubbed warning mapper. */
async function inspect() {
  return { status: await collectStatus(ctx.dir), lint: await lint(ctx.dir) };
}

/** A healthy page is pending; one exhausted page occurs in both files after a crash. */
async function seed(pendingAttempts = 4) {
  await writePendingEmbeddings(ctx.dir, [{ pageId: "concepts/stopped", attempts: 5 }], QUARANTINED_EMBEDDINGS_FILE);
  await writePendingEmbeddings(ctx.dir, [
    { pageId: "concepts/stopped", attempts: pendingAttempts },
    { pageId: "concepts/overflow", attempts: 5 },
    { pageId: "concepts/waiting", attempts: 1 },
  ]);
}

it.each([4, 5])("counts distinct stopped pages with pending at %i attempts without draining either file", async (attempts) => {
  await seed(attempts);
  const files = [PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE].map(file => path.join(ctx.dir, file));
  const before = await Promise.all(files.map(file => readFile(file, "utf8")));
  const result = await inspect();
  expect(result.status.warnings).toContainEqual(expect.objectContaining({ code: QUARANTINED, message: expect.stringContaining("2 page(s)") }));
  expect(result.status.warnings).toContainEqual(expect.objectContaining({ code: "embeddings-refresh-pending", message: expect.stringContaining("1 page(s)") }));
  expect(result.lint.results).toContainEqual(expect.objectContaining({ rule: "quarantined-embeddings", severity: "warning", message: expect.stringContaining(QUARANTINED) }));
  expect(await Promise.all(files.map(file => readFile(file, "utf8")))).toEqual(before);
});

it("keeps clean projects free of quarantine warnings", async () => {
  const result = await inspect();
  expect(result.status.warnings).toBeUndefined();
  expect(result.lint.results.some(f => f.rule === "quarantined-embeddings")).toBe(false);
});

it("reports exhausted pending entries even without a quarantine file", async () => {
  await writePendingEmbeddings(ctx.dir, [{ pageId: "concepts/held", attempts: 5 }]);
  const result = await inspect();
  expect(result.status.warnings?.map(w => w.code)).toEqual([QUARANTINED]);
  expect(result.lint.results).toContainEqual(expect.objectContaining({ rule: "quarantined-embeddings", file: PENDING_EMBEDDINGS_FILE }));
});

it.each(["{bad", "{}"])("reports an unreadable quarantine instead of healthy status: %s", async (body) => {
  await writeFile(path.join(ctx.dir, QUARANTINED_EMBEDDINGS_FILE), body);
  const result = await inspect();
  expect(result.status.warnings?.map(w => w.code)).toContain(UNAVAILABLE);
  expect(result.lint.results).toContainEqual(expect.objectContaining({ rule: "quarantined-embeddings", message: expect.stringContaining(UNAVAILABLE) }));
});

it("does not follow a quarantine symlink or change its target", async () => {
  const target = path.join(ctx.dir, "victim.json");
  await writeFile(target, "[]");
  await symlink(target, path.join(ctx.dir, QUARANTINED_EMBEDDINGS_FILE));
  expect((await inspect()).status.warnings?.map(w => w.code)).toContain(UNAVAILABLE);
  expect(await readFile(target, "utf8")).toBe("[]");
});

it("surfaces quarantine through real CLI lint and status JSON", async () => {
  await seed();
  const status = await runCLI(["status", "--json"], ctx.dir);
  expectCLIExit(status, 0);
  expect(JSON.parse(status.stdout).warnings).toContainEqual(expect.objectContaining({ code: QUARANTINED }));
  const checked = await runCLI(["lint"], ctx.dir);
  expectCLIExit(checked, 0);
  expect(checked.stdout).toContain(`${QUARANTINED}:`);
}, 30_000);
