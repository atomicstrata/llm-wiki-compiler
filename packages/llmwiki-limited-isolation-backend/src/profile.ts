/**
 * @file packages/llmwiki-limited-isolation-backend/src/profile.ts
 * @description The seatbelt (macOS) profile and bubblewrap (Linux) argument
 * vector for the limited-isolation backend. TWO controls only, deliberately:
 * deny all network, and confine file WRITES to the scratch + output roots.
 * Reads are left broad — env/FD/proc/tree-kill isolation is UNENFORCED and
 * documented as such; this backend is for trusted experiment code, not a
 * security boundary.
 */

/** The seatbelt profile source: deny network, confine writes to the allowed roots. */
export function seatbeltProfile(writableRoots: readonly string[]): string {
  const writable = writableRoots
    .map((root) => `(subpath ${JSON.stringify(root)})`)
    .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* ${writable})`,
    // /dev/null and the tty are needed for an ordinary process to run.
    '(allow file-write-data (regex #"^/dev/null$") (regex #"^/dev/tty"))',
  ].join("\n");
}

/** The bubblewrap argv wrapping a command: no network, scratch bound writable. */
export function bubblewrapArgs(
  writableRoots: readonly string[], launchRoot: string,
): readonly string[] {
  const binds = writableRoots.flatMap((root) => ["--bind", root, root]);
  return [
    // Drop ALL capabilities FIRST: bubblewrap preserves a real UID-0 caller's
    // effective capabilities otherwise, and a retained CAP_SYS_ADMIN can
    // remount the read-only tree writable or re-enter the parent net namespace
    // via setns — undoing both controls this backend claims. The one
    // privileged-caller closure the limited scope still owes.
    "--cap-drop", "ALL",
    "--unshare-net",
    "--ro-bind", "/", "/",
    "--ro-bind", launchRoot, launchRoot,
    ...binds,
    "--dev", "/dev",
    "--proc", "/proc",
  ];
}
