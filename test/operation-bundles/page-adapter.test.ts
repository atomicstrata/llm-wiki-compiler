/**
 * @file test/operation-bundles/page-adapter.test.ts
 * @description Task 3 five-way observation + apply tests for the page adapter,
 * which lands bytes only through the existing planner/executor page authority.
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pageAdapter } from "../../src/operation-bundles/adapters/page.js";
import type { OperationDigest, PageOperationMutation } from "../../src/operation-bundles/types.js";
import { digestOf, makeBinding, makeContext, publishPayload, type BindingSet } from "./adapter-fixtures.js";

const BODY = Buffer.from("# raw page body\n");
const DIR = "notes";
const SLUG = "a";

function pageMutation(set: BindingSet, digest: OperationDigest): PageOperationMutation {
  return {
    kind: "page", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "create", target: { kind: "raw", directory: DIR, slug: SLUG },
    payloadRef: digest.slice("sha256:".length), precondition: { kind: "absent" },
    postcondition: { digest, byteCount: BODY.byteLength },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "page-adapter-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function writePage(bytes: Buffer): Promise<void> {
  await mkdir(path.join(root, "wiki", DIR), { recursive: true });
  await writeFile(path.join(root, "wiki", DIR, `${SLUG}.md`), bytes);
}

describe("pageAdapter.observe", () => {
  it("reports not-applied when the page is absent and the precondition allows", async () => {
    const set = makeBinding();
    const observation = await pageAdapter.observe(makeContext(root, pageMutation(set, digestOf(BODY)), set));
    expect(observation.outcome).toBe("not-applied");
  });

  it("reports applied when the page matches the postcondition digest", async () => {
    await writePage(BODY);
    const set = makeBinding();
    const observation = await pageAdapter.observe(makeContext(root, pageMutation(set, digestOf(BODY)), set));
    expect(observation.outcome).toBe("applied");
    expect(observation.postStateDigest).toBe(digestOf(BODY));
  });

  it("reports conflict when the page matches neither precondition nor postcondition", async () => {
    await writePage(Buffer.from("something else entirely\n"));
    const set = makeBinding();
    const observation = await pageAdapter.observe(makeContext(root, pageMutation(set, digestOf(BODY)), set));
    expect(observation.outcome).toBe("conflict");
  });
});

describe("pageAdapter.apply", () => {
  it("lands the payload bytes and verifies the postcondition", async () => {
    const set = makeBinding();
    const digest = digestOf(BODY);
    await publishPayload(root, set.bundleId, BODY);
    const ctx = makeContext(root, pageMutation(set, digest), set);
    const result = await pageAdapter.apply(ctx);
    expect(result.status).toBe("applied");
    const verify = await pageAdapter.verify(ctx);
    expect(verify.status).toBe("verified");
  });
});
