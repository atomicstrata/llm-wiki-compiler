/**
 * @file src/profile/templates/taps/private-root.ts
 * @description Safe creation of private operator config and cache roots.
 */
import { chmod, lstat, mkdir } from "node:fs/promises";

/** Create a non-symlinked private root and enforce owner-only POSIX permissions. */
export async function ensurePrivateRoot(root: string): Promise<void> {
  const existing = await lstat(root).catch((error) => absentOrThrow(error));
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("template tap root must be a real directory");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("template tap root must be a real directory");
  if (process.platform !== "win32") await chmod(root, 0o700);
}

function absentOrThrow(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}
