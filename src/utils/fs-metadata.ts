/**
 * @file Path metadata lookups (`lstat`, `stat`, `realpath`) made synchronously,
 * behind the promise signatures of `node:fs/promises`.
 *
 * The confinement and durability checks ask the kernel about the same few
 * paths thousands of times per operation. Each lookup is a sub-microsecond
 * syscall answered from the kernel's caches, but the promise form sends it to
 * the runtime's thread pool and back: under Bun an async `lstat` costs about
 * 10 µs and `lstatSync` under 1 µs, `realpath` about 18 µs against 6 µs.
 * Doing the syscall in place keeps the answer, the error and the call order
 * the same and drops the round trip.
 *
 * Only metadata belongs here. Opening, reading, writing and syncing stay
 * asynchronous: those can wait on the device.
 */

import fs from "node:fs";
import type * as fsPromises from "node:fs/promises";

// Each call reads the function off the `fs` module when it runs, so whatever
// wraps the module (the test call counter, a mock) sees every lookup.

/** `fs.promises.lstat`, answered in place. */
export const lstat = (async (target: string, options?: { bigint?: boolean }) =>
  fs.lstatSync(target, options)) as typeof fsPromises.lstat;

/** `fs.promises.stat`, answered in place. */
export const stat = (async (target: string, options?: { bigint?: boolean }) =>
  fs.statSync(target, options)) as typeof fsPromises.stat;

/** `fs.promises.realpath`, answered in place. */
export const realpath = (async (target: string) => fs.realpathSync(target)) as typeof fsPromises.realpath;
