/** Small real TypeScript projects for checking the public test gate without repository backlog noise. */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Create a no-emit project with a nested test directory; the caller removes it. */
export async function createTypecheckProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "test-typecheck-"));
  await mkdir(path.join(root, "test", "nested"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.test.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], rootDir: "." },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }));
  return root;
}
