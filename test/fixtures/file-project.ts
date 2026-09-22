/** Tracked literal file layouts for subprocess tests; no profile or compiler initialization. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach } from "vitest";
import { tempRootTracker } from "../temp-roots.js";

/** Register cleanup and return a factory writing a declared relative-path layout. */
export function useFileProject(prefix: string) {
  const tracker = tempRootTracker();
  afterEach(() => tracker.cleanup());
  return async (files: Readonly<Record<string, string>>): Promise<string> => {
    const root = await tracker.create(prefix, { real: true });
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return root;
  };
}
