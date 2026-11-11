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
 * ANY DOUBT RETURNS `undefined`, which sends the caller back to `ps`. That covers
 * every platform but macOS (Linux `ps` renders from `/proc` with its own boot-time
 * arithmetic, which this module does not claim to reproduce), a runtime without
 * `bun:ffi`, a failing call, a record of an unexpected size, and a record that
 * names a different pid. So this route can only ever agree with `ps` or step
 * aside for it; it never answers differently.
 */

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

/** Bind libc `sysctl` through `bun:ffi`, or `null` when that is not possible here. */
function bindSysctl(): SysctlCall | null {
  if (process.platform !== "darwin") return null;
  try {
    const { dlopen, FFIType, ptr } = import.meta.require("bun:ffi") as typeof import("bun:ffi");
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
 * — or `undefined` when this host cannot answer natively and `ps` must be asked.
 *
 * @param pid - A signalable pid (see `isSignalablePid`).
 */
export function readKernelStartSeconds(pid: number): number | undefined {
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
