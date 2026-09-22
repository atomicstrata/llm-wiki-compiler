/**
 * @file test/preparations/lifecycle-read-attempts.test.ts
 * @description Exact namespace-opener attempt counts for one lifecycle read.
 *
 * `capturePreparationLifecycleRead` is one try/catch with no retry, and the
 * no-retry property is load-bearing: a retried capture observes a SECOND
 * filesystem state, so a fault that clears between attempts would be reported as
 * a clean read of a namespace that was never clean when the decision began, and
 * a fault that persists would double every read's I/O under exactly the
 * conditions where the filesystem is already degraded.
 *
 * Nothing proved it. The lease suite counts CALLBACK invocations, which stay at
 * one however many times the opener is attempted, and inserting a retry left all
 * five of those tests green. This counts opener attempts directly on the
 * production path, which is the only place the property is observable.
 *
 * Deliberately separate from the scanner-attempt proof in
 * lifecycle-single-capture.test.ts: that one counts `opendir` calls against the
 * physical registry roots and answers "how many times was the store enumerated",
 * while this one answers "how many times was the namespace bound". A single
 * counter cannot fail for both reasons distinguishably.
 */

import { describe, expect, it, vi } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";

const openerProbe = vi.hoisted(() => ({ modes: [] as string[] }));

type NamespaceModule = typeof import("../../src/preparations/lifecycle-fs/namespace.js");

vi.mock("../../src/preparations/lifecycle-fs/namespace.js", async () => {
  const actual = await vi.importActual<NamespaceModule>(
    "../../src/preparations/lifecycle-fs/namespace.js",
  );
  return {
    ...actual,
    // The real opener still runs, so the returned namespace keeps its genuine
    // brand and every downstream revalidation behaves exactly as in production.
    openPreparationLifecycleNamespace: async (
      root: Parameters<NamespaceModule["openPreparationLifecycleNamespace"]>[0],
      mode: Parameters<NamespaceModule["openPreparationLifecycleNamespace"]>[1],
    ) => {
      openerProbe.modes.push(mode);
      return actual.openPreparationLifecycleNamespace(root, mode);
    },
  };
});

import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { withPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";
import { enumeratePreparationReferences } from "../../src/preparations/references.js";

/** Make the private root unbindable so the namespace capture fails outright. */
async function unbindablePrivateRoot(dir: string): Promise<void> {
  const decoy = path.join(dir, "decoy");
  await mkdir(decoy, { recursive: true });
  await symlink(decoy, path.join(dir, ".llmwiki"));
}

describe("one lifecycle read binds the namespace exactly once", () => {
  const root = useTempRoot();

  it("does not retry a failing namespace capture", async () => {
    await unbindablePrivateRoot(root.dir);
    openerProbe.modes.length = 0;

    const read = await withPreparationLifecycleRead(root.dir, (value) => value);

    expect(read.status).toBe("unavailable");
    expect(openerProbe.modes).toEqual(["read"]);
  });

  it("binds once for a successful capture", async () => {
    openerProbe.modes.length = 0;

    const status = await withPreparationLifecycleRead(root.dir, (read) => read.status);

    expect(status).toBe("ok");
    expect(openerProbe.modes).toEqual(["read"]);
  });

  it("binds once for one complete read-only decision", async () => {
    // Reference composition is the decision that reads the store through two
    // halves; both must be served by the same single binding.
    openerProbe.modes.length = 0;

    expect((await enumeratePreparationReferences(root.dir)).complete).toBe(true);

    expect(openerProbe.modes).toEqual(["read"]);
  });
});
