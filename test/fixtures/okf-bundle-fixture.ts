/**
 * @file Shared test fixture: write a minimal one-doc OKF bundle under a root.
 *
 * Several import tests need the same starting point — a `kb/` bundle holding a
 * single valid concept doc — so the directory layout + frontmatter live here
 * rather than being copy-pasted into each test.
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";

/**
 * Create `<root>/kb/concepts/a.md` (a single valid OKF concept doc) and return
 * the bundle directory path (`<root>/kb`), ready to pass to runOkfImport.
 */
export async function writeOneDocBundle(root: string): Promise<string> {
  const bundleDir = path.join(root, "kb");
  await mkdir(path.join(bundleDir, "concepts"), { recursive: true });
  await writeFile(path.join(bundleDir, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
  return bundleDir;
}
