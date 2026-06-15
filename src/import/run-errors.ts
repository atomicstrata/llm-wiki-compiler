/** @file Typed sentinels for OKF import control-flow conditions, so callers (CLI/SDK/MCP) discriminate without string-matching. */

/** Thrown when a real (non-dry-run) import can't take the `.llmwiki/lock`. */
export class LockUnavailableError extends Error {
  constructor(message = "Could not acquire lock. Try again later.") {
    super(message);
    this.name = "LockUnavailableError";
  }
}

/** Thrown when staging would push pending review candidates over a caller-supplied cap. */
export class QueueFullError extends Error {
  constructor(message = "Review queue would exceed the cap; approve/reject pending candidates first.") {
    super(message);
    this.name = "QueueFullError";
  }
}
