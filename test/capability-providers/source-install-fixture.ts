/**
 * @file test/capability-providers/source-install-fixture.ts
 * @description ONE home for the "install a one-binary provider from its source
 * string" idiom: write the source tree, build the matching distribution payload
 * (whose digests are computed from those EXACT bytes, so the installer's tree
 * verification passes only because the declaration matches what is there), and
 * install with execution approved.
 *
 * Four suites installed providers this way with a copy each — the echo, probe,
 * research, and discovery providers — and a copy per file is how the artifact
 * contract or the payload shape drifts: the copy that is missed keeps passing
 * against a setup nobody else uses any more.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installDevProvider } from "../../src/capability-providers/host/index.js";
import type { AuthorizedProviderPaths } from "../../src/capability-providers/packages/paths.js";
import { providerDistribution } from "../fixtures/capability-provider-package.js";

/** The single JSON `extraction` artifact every one-binary fixture declares. */
const EXTRACTION_OUTPUT = {
  outputId: "extraction", required: true, mediaTypes: ["application/json"],
  maximumFiles: 1, maximumBytes: 65_536,
} as const;

/**
 * Write `source` as a provider tree and install it, execution approved.
 *
 * @param paths - The resolution fixture's authorized provider paths.
 * @param source - The provider script (a self-contained CommonJS program).
 * @param treePrefix - The temp-directory prefix naming the suite's tree.
 * @returns The installed provider, pin included.
 */
export async function installProviderFromSource(
  paths: AuthorizedProviderPaths, source: string, treePrefix: string,
  artifactOutputs: NonNullable<Parameters<typeof providerDistribution>[1]> = [EXTRACTION_OUTPUT],
  identity?: Parameters<typeof providerDistribution>[2],
): Promise<Awaited<ReturnType<typeof installDevProvider>>> {
  const sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), treePrefix)));
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await writeFile(path.join(sourceRoot, "bin", "provider"), source, "utf8");
  try {
    return await installDevProvider(paths, {
      sourceRoot,
      payload: providerDistribution({ "package/bin/provider": source }, artifactOutputs, identity).payload,
      approveExecution: true,
    });
  } finally {
    // SELF-CLEANING: the installer COPIES out of this tree, so it is dead the
    // moment the call settles. Removing it here rather than in each caller's
    // `afterEach` means a new consumer cannot forget and leak one directory per
    // install — and the `finally` covers the refusal paths too.
    //
    // SWALLOWED DELIBERATELY: `force` does not suppress every removal failure,
    // and a cleanup rejection thrown from `finally` would REPLACE the install
    // error that actually explains the test failure. A leaked temp directory is
    // a smaller problem than an unexplainable refusal.
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
