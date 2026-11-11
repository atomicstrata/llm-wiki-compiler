/**
 * @file src/utils/kernel-start-time.ts
 * @description Read a process's start second straight from the kernel record
 * that `ps -o lstart=` itself prints, so the lock owner need not fork `ps`.
 *
 * WHY THIS IS THE SAME NUMBER `ps` SHOWS, NOT AN APPROXIMATION OF IT. On macOS,
 * `ps` gets every process from `sysctl(CTL_KERN, KERN_PROC, …)` as a
 * `struct kinfo_proc`, and its `lstart` column is
 * `strftime("%c", localtime(&kp_proc.p_starttime.tv_sec))` — the microseconds
 * are dropped by taking `tv_sec`, a truncation, never a rounding. This module
 * reads the SAME field of the SAME kernel record with the SAME truncation. With
 * `TZ=UTC LC_ALL=C` (how `readProcessStartTime` pins `ps`), parsing that
 * rendering back as UTC returns exactly `tv_sec`, so both routes produce the
 * identical `unix:<tv_sec>`. Measured against every process on a host, zombies
 * included: no difference. Nothing here derives the start from elapsed time,
 * `performance.timeOrigin` or the runtime's own startup clock — those are taken
 * after `exec`, some milliseconds late, and would land on the next second
 * whenever a second boundary fell in between: a live holder read as a reused pid.
 *
 * On Linux, procps renders `lstart` as `btime + starttime / Hertz` (integer
 * division) from `/proc/stat` and `/proc/<pid>/stat`; {@link readProcStartSeconds}
 * computes that same sum from the same files. An unreadable record there is
 * `null` (no start time), since `ps` would read the same files.
 *
 * On macOS ANY DOUBT RETURNS `undefined`, which sends the caller back to `ps`:
 * a runtime without `bun:ffi`, a failing call, a record of an unexpected size,
 * and a record that names a different pid. Other platforms always return
 * `undefined`. So this route can only ever agree with `ps` or step aside for it;
 * it never answers differently.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** `CTL_KERN`, `KERN_PROC`, `KERN_PROC_PID`: the mib prefix `ps` uses for one pid. */
const KERN_PROC_PID_MIB = [1, 14, 1] as const;
/** `sizeof(struct kinfo_proc)` on every 64-bit Darwin (arm64 and x86_64). */
const KINFO_PROC_SIZE = 648;
/** Offset of `kp_proc.p_starttime.tv_sec` (the first member of `extern_proc`). */
const START_SECONDS_OFFSET = 0;
/** Offset of `kp_proc.p_pid`, read back to confirm the record names the pid asked for. */
const PID_OFFSET = 40;

/** The one libc function this module calls. */
type SysctlCall = (mib: Int32Array, mibLength: number, record: Uint8Array, length: BigUint64Array) => number;

/** `sysctl`, once bound; `null` when this host has no usable route. */
let boundSysctl: SysctlCall | null | undefined;

/**
 * The slice of `bun:ffi` this module calls. The published CLI runs on Node, so
 * the project does not compile against Bun's types; under Node the require below
 * throws and the caller falls back to `ps`.
 */
interface BunFfi {
  dlopen(path: string, symbols: Record<string, { args: unknown[]; returns: unknown }>):
    { symbols: Record<string, (...args: unknown[]) => number> };
  FFIType: Record<"ptr" | "u32" | "u64" | "i32", unknown>;
  ptr(view: ArrayBufferView): unknown;
}

/** Bind libc `sysctl` through `bun:ffi`, or `null` when that is not possible here. */
function bindSysctl(): SysctlCall | null {
  if (process.platform !== "darwin") return null;
  try {
    const { dlopen, FFIType, ptr } = createRequire(import.meta.url)("bun:ffi") as BunFfi;
    const libc = dlopen("/usr/lib/libSystem.B.dylib", {
      sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    });
    return (mib, mibLength, record, length) =>
      libc.symbols.sysctl(ptr(mib), mibLength, ptr(record), ptr(length), null, 0);
  } catch {
    return null;
  }
}

/**
 * The kernel's start second for `pid` — exactly the value `ps -o lstart=` renders
 * — `null` when Linux `/proc` has no record for it, or `undefined` when this host
 * cannot answer natively and `ps` must be asked.
 *
 * @param pid - A signalable pid (see `isSignalablePid`).
 */
export function readKernelStartSeconds(pid: number): number | null | undefined {
  if (process.platform === "linux") return readProcStartSeconds(pid);
  if (boundSysctl === undefined) boundSysctl = bindSysctl();
  if (boundSysctl === null) return undefined;
  const record = new Uint8Array(KINFO_PROC_SIZE);
  const length = new BigUint64Array([BigInt(KINFO_PROC_SIZE)]);
  const status = boundSysctl(new Int32Array([...KERN_PROC_PID_MIB, pid]), KERN_PROC_PID_MIB.length + 1, record, length);
  // A gone pid comes back as success with length 0; it, an error, and any record
  // this module was not written against all defer to `ps` rather than guess.
  if (status !== 0 || length[0] !== BigInt(KINFO_PROC_SIZE)) return undefined;
  const view = new DataView(record.buffer);
  if (view.getInt32(PID_OFFSET, true) !== pid) return undefined;
  return Number(view.getBigInt64(START_SECONDS_OFFSET, true));
}

/**
 * Linux `USER_HZ`: the unit of `/proc/<pid>/stat` `starttime`, and the `Hertz`
 * procps divides by. Fixed at 100 on every architecture this project runs on.
 */
const LINUX_USER_HZ = 100;
/** `starttime` (field 22 of `/proc/<pid>/stat`) counted from field 3, the first after `comm`. */
const STARTTIME_AFTER_COMM = 19;

/**
 * Linux: `ps -o lstart=` (procps 3.3 and 4) prints `btime + starttime / Hertz`,
 * `btime` from `/proc/stat` and integer division. This is that same sum, read
 * from the same files, so no `ps` is forked: under Bun a synchronous spawn can
 * spin forever beside its exited child (oven-sh/bun#46488). An unreadable
 * record is `null`, not a cue to ask `ps`, which reads the same files.
 */
function readProcStartSeconds(pid: number): number | null {
  try {
    const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `comm` may hold spaces and parentheses; the fields resume after the LAST `)`.
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[STARTTIME_AFTER_COMM];
    if (btime === undefined || ticks === undefined || !/^\d+$/.test(ticks)) return null;
    return Number(btime) + Math.floor(Number(ticks) / LINUX_USER_HZ);
  } catch {
    return null;
  }
}
