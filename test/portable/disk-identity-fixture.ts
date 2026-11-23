/**
 * @file test/portable/disk-identity-fixture.ts
 * @description The shared redirected-temp fixture of the identity/marker
 * regressions (`disk-identity-durability.test.ts` and
 * `disk-identity-adoption.test.ts`).
 *
 * Each test gets a fresh `realpath`'d directory under `os.tmpdir()` (the
 * harness redirects TMPDIR) holding `project/`, removed after the test. Hooks
 * are the storage-profile ones, so the profile's budgets apply. Every path is
 * explicit: nothing here touches default host control or operator state, mocks
 * the filesystem or replaces a provider.
 *
 * Not a test file (no `.test.` in its name): it only registers hooks for the
 * file that calls {@link useIdentityFixture}.
 */

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { ledgerDir } from "../../src/portable/store/disk-layout.js";

/** One test's fixture paths; reassigned before every test. */
export interface IdentityFixture {
  /** The fresh temp directory; removed after each test. */
  base: string;
  /** The fixture project root, `<base>/project`. */
  root: string;
  /** The fixture's ledger directory of `kind`, created. */
  ledger(kind: "open" | "identity"): Promise<string>;
}

/**
 * Register per-test setup and cleanup in the calling test file and return the
 * mutable fixture record they maintain. Call once, at module level.
 */
export function useIdentityFixture(): IdentityFixture {
  const fixture: IdentityFixture = {
    base: "",
    root: "",
    async ledger(kind) {
      const dir = path.join(fixture.root, ledgerDir(kind));
      await mkdir(dir, { recursive: true });
      return dir;
    },
  };
  beforeEach(async () => {
    fixture.base = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-identity-durability-")));
    fixture.root = path.join(fixture.base, "project");
    await mkdir(fixture.root, { recursive: true });
  });
  afterEach(async () => {
    await rm(fixture.base, { recursive: true, force: true });
  });
  return fixture;
}
