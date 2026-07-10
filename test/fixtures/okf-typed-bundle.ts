/**
 * @file Shared test fixture for the typed profile-entity OKF import suites: write
 * a `kb/` bundle from a rel-path -> content map. Both `okf-profile-import.test.ts`
 * and `okf-profile-import-trusted.test.ts` author bundle docs directly, so the
 * write mechanics live here rather than being copy-pasted per suite.
 */
import { mkdir, writeFile } from "fs/promises";
import path from "path";

/**
 * Write a `<root>/kb/` OKF bundle from a rel-path -> file-content map and return
 * the bundle directory path, ready to pass to `runOkfImport` / `importOkfBundle`.
 *
 * @param root - Absolute project root directory.
 * @param docs - Map of bundle-relative path to full markdown file content.
 * @returns The bundle directory (`<root>/kb`).
 */
export async function writeTypedBundle(root: string, docs: Record<string, string>): Promise<string> {
  const bundleDir = path.join(root, "kb");
  for (const [rel, content] of Object.entries(docs)) {
    const abs = path.join(bundleDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return bundleDir;
}
