/** behind the promise signatures of `node:fs/promises`. */

import fs from "node:fs";
import type * as fsPromises from "node:fs/promises";


/** `fs.promises.lstat`, answered in place. */
export const lstat = (async (target: string, options?: { bigint?: boolean }) =>
  fs.lstatSync(target, options)) as typeof fsPromises.lstat;

/** `fs.promises.stat`, answered in place. */
export const stat = (async (target: string, options?: { bigint?: boolean }) =>
  fs.statSync(target, options)) as typeof fsPromises.stat;

/** `fs.promises.realpath`, answered in place. */
export const realpath = (async (target: string) => fs.realpathSync.native(target)) as typeof fsPromises.realpath;
