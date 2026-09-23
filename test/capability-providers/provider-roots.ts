/**
 * @file test/capability-providers/provider-roots.ts
 * @description Shared setup for provider-package suites: owner-private (0700)
 * `config` and `cache` directories under a caller-owned root, authorized through
 * the production path seam. Only setup lives here; each suite still states the
 * boundary it attacks in its own test body.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { authorizeProviderPathsForTest } from "../../src/capability-providers/packages/paths.js";

/** Create and authorize the provider config/cache roots inside `root`. */
export async function authorizedProviderRoots(root: string, nowForTest: () => Date) {
  await mkdir(path.join(root, "config"), { mode: 0o700 });
  await mkdir(path.join(root, "cache"), { mode: 0o700 });
  return authorizeProviderPathsForTest({
    configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache"), nowForTest,
  });
}
