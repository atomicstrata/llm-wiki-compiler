/**
 * Read an explicitly selected operator instruction file for one compile.
 * This is not project-file discovery or a confinement boundary: absolute paths
 * and symlinks are allowed. Bound the read to keep accidental large inputs out
 * of prompts, and reject special files rather than waiting on a pipe.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { readBoundedFromHandle } from "../profile/templates/publish/bounded-read.js";

const MAX_INSTRUCTION_BYTES = 64 * 1024;

/** Load bounded UTF-8 instructions; omission preserves the default prompt. */
export async function readInstructions(file: string | undefined): Promise<string | undefined> {
  if (file === undefined) return undefined;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("must be a regular file");
      const bytes = await readBoundedFromHandle(handle, MAX_INSTRUCTION_BYTES, "Instruction file (maximum 64 KiB)");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error(`Cannot read instructions from ${file}: ${error instanceof Error ? error.message : error}`);
  }
}
