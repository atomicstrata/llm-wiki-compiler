/**
 * @file src/operator-state/private-root.ts
 * @description Legacy TAP leaf-directory compatibility behavior. This helper
 * intentionally follows existing ancestor symlinks and is insufficient to
 * authorize any Provider V2 store or other privilege-bearing state.
 */
import { chmod, lstat, mkdir } from "node:fs/promises";

/**
 * Preserve TAP's leaf-only directory and POSIX-mode behavior.
 *
 * This path-based helper does not verify ancestor ownership or confinement and
 * is not the no-follow, handle-bound Provider V2 authorization seam.
 */
export async function ensurePrivateRoot(root: string): Promise<void> {
  const existing = await lstat(root).catch((error) => absentOrThrow(error));
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("template tap root must be a real directory");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("template tap root must be a real directory");
  }
  if (process.platform !== "win32") await chmod(root, 0o700);
}

function absentOrThrow(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}
