/**
 * @file test/portable/scale-first-open.test.ts
 * @description Open a pre-existing curated page through the public local SDK
 * before any v1 read can establish its label binding. The uncontended fixture
 * uses a PID-only owner record to keep native identity probes outside the check.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, spyOn } from "bun:test";
import { registerProject } from "../../src/portable/index.js";
import { openPagedProject } from "../../src/portable/scale/open.js";
import { ACCESS_NOTICE } from "../../src/portable/contracts.js";
import { LocalHostControl } from "../../src/portable/host/local-control.js";
import { ledgerFile, ledgerKey } from "../../src/portable/store/disk-layout.js";
import { DiskProjectStore } from "../../src/portable/store/disk-store.js";
import * as lockOwner from "../../src/utils/lock-owner.js";

const ID = "legacy";
const PAGE = `wiki/concepts/${ID}.md`;
const BODY = "---\ntitle: Existing page\n---\n\nLegacy café.\n";
const DIGEST = `sha256:${createHash("sha256").update(BODY).digest("hex")}` as const;
type Session = Awaited<ReturnType<typeof openPagedProject>>;

/** Give one case its own registered directory, control files and uncontended lock. */
async function withPage(action: (root: string, session: Session) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "llmwiki-paged-first-open-"));
  const root = path.join(scratch, "project");
  const previousConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(scratch, "config");
  // Keep real lock publication, admission and release; this fixture has no other PID to distinguish.
  const owner = spyOn(lockOwner, "serializeOwner").mockImplementation((pid) => JSON.stringify({ pid }));
  try {
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(path.join(root, PAGE), BODY);
    await registerProject(root);
    const session = await openPagedProject({
      project: { localRoot: root }, credential: { kind: "local-os" }, protocols: ["portable-scale/2"],
    });
    await action(root, session);
    expect(owner).toHaveBeenCalledWith(process.pid);
  } finally {
    owner.mockRestore();
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Put an exact committed binding in the synthetic ledger and return its path. */
async function bindFixturePage(root: string, labels: string[]): Promise<string> {
  const location = path.join(root, ledgerFile("labels", ledgerKey(PAGE)));
  await mkdir(path.dirname(location), { recursive: true });
  await writeFile(location, JSON.stringify({ path: PAGE, digest: DIGEST, labels }));
  return location;
}

/** An owner's first paged open should serve the legacy page with one revision/body identity. */
it("opens an existing local page before any v1 read", () => withPage(async (root, session) => {
  const file = await stat(path.join(root, PAGE), { bigint: true });
  const revision = [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(".");
  const answer = await session.paged.pages.open(ID);
  expect(answer.kind).toBe("opened");
  expect(answer).toEqual({
    kind: "opened", custody: "v1-compatibility", notice: ACCESS_NOTICE,
    page: { id: ID, path: PAGE, title: PAGE, digest: DIGEST, revision: `${revision}:${DIGEST}`,
      byteCount: Buffer.byteLength(BODY), body: BODY },
  });
}));

/** A committed restriction survives, and neither a missing page nor an invalid path is served. */
it("withholds a restricted or unavailable local page", () => withPage(async (root, session) => {
  const location = await bindFixturePage(root, ["other-compartment"]);
  const before = await Bun.file(location).text();
  for (const id of [ID, "absent", "../legacy"]) {
    expect(await session.paged.pages.open(id)).toEqual({ kind: "not_visible", notice: ACCESS_NOTICE });
  }
  expect(await Bun.file(location).text()).toBe(before);
}));

/** Revoke the fixture grant after a real observation while the gate is held. */
it("refuses when page authority changes during the local observation", () => withPage(async (root, session) => {
  const control = await LocalHostControl.open();
  const record = await control.loadProject(session.principal.project);
  if (record === null) throw new Error("fixture project was not registered");
  await bindFixturePage(root, [record.compartment]);
  const observe = DiskProjectStore.prototype.observe;
  const interpose = spyOn(DiskProjectStore.prototype, "observe").mockImplementation(async function (this: DiskProjectStore, target) {
    const observed = await observe.call(this, target);
    expect(observed?.digest).toBe(DIGEST);
    expect(await Bun.file(path.join(root, ".llmwiki", "lock")).exists()).toBe(true);
    await control.saveProject({ ...record, bindings: [], policyRevision: record.policyRevision + 1 });
    return observed;
  });
  try {
    expect(await session.paged.pages.open(ID)).toEqual({ kind: "refused", code: "permission_denied", notice: ACCESS_NOTICE });
    expect(interpose).toHaveBeenCalledTimes(1);
    expect(await Bun.file(path.join(root, ".llmwiki", "lock")).exists()).toBe(false);
  } finally {
    interpose.mockRestore();
  }
}));
