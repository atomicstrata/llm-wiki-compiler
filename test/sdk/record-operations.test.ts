/** @file SDK effect authority is host-captured and preparation-only. These
 * witnesses exercise the public createWiki surface without CLI authority. */
import { expect, it } from "vitest";
import { createWiki } from "../../src/sdk/wiki.js";
import { useTempRoot } from "../fixtures/temp-root.js";
import { SAMPLE_PROFILE, writeProfileFile } from "../fixtures/profile-fixtures.js";
import { loadProfile } from "../../src/profile/load.js";

const root = useTempRoot();
async function input() {
  await writeProfileFile(root.dir, SAMPLE_PROFILE);
  return { schema: "llmwiki-record-intent-v1" as const, workspaceId: "demo", effectId: "one",
    profileDigest: `sha256:${(await loadProfile(root.dir)).digest}` as const, target: { entityType: "notes", slug: "one" },
    precondition: { kind: "absent" as const }, proposedBody: "---\ntitle: Synthetic\n---\nBody\n",
    origin: { provider: "llmflow", runId: "run", occurrenceId: "one", proposalDigest: `sha256:${"a".repeat(64)}` as const } };
}

it("defaults to read-only and never exposes apply", async () => {
  const wiki = createWiki({ root: root.dir });
  expect(Object.keys(wiki.operations).sort()).toEqual(["observeEffect", "prepareRecord", "retireEffect"]);
  expect(await wiki.operations.prepareRecord(await input())).toEqual({ status: "refused", code: "record-prepare-grant-required" });
});

it("captures host grants and request bytes before deferred execution", async () => {
  const grants: "operation-bundle.prepare"[] = ["operation-bundle.prepare"];
  const wiki = createWiki({ root: root.dir, operations: { id: "flow", grants } });
  grants.length = 0;
  const intent = await input(), pending = wiki.operations.prepareRecord(intent);
  intent.proposedBody = "changed"; intent.target.slug = "changed";
  const result = await pending; expect(result.status).toBe("prepared");
  if (result.status !== "prepared") return;
  const observation = await wiki.operations.observeEffect(result.ref);
  expect(observation.status).toBe("observed");
  if (observation.status === "observed") expect(observation.pages[0]?.target).toMatchObject({ slug: "one" });
  expect((await wiki.operations.retireEffect(result.ref)).status).toBe("observed");
});

it("does not evaluate option accessors or accept inherited operation grants", async () => {
  let called = 0;
  const options = { root: root.dir };
  Object.defineProperty(options, "operations", { get() { called++; return { grants: ["operation-bundle.prepare"] }; } });
  const wiki = createWiki(options);
  expect(called).toBe(0);
  expect((await wiki.operations.prepareRecord(await input())).status).toBe("refused");
  const inherited = Object.assign(Object.create({ operations: { grants: ["operation-bundle.prepare"] } }), { root: root.dir });
  expect((await createWiki(inherited).operations.prepareRecord(await input())).status).toBe("refused");
});
