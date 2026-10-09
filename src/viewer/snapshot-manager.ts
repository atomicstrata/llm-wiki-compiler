/**
 * Dynamic snapshot manager for the llmwiki viewer.
 *
 * Implements throttled, on-request snapshot rebuilding (Issue #272):
 *   - Atomic swap: Rebuilds via `buildViewerSnapshot` and replaces the snapshot
 *     reference atomically upon completion, so requests never observe partial state.
 *   - Mutex / in-flight dedup: Never executes two rebuilds concurrently. Requests
 *     arriving while a rebuild is in progress immediately receive the previous snapshot.
 *   - Debounce floor: Enforces a minimum interval (default 5,000 ms, min 1,000 ms)
 *     between rebuilds to prevent frequent disk scans on large wikis.
 *   - Resilient fallback: If rebuilding throws an error or returns a mismatched root,
 *     preserves the previous valid snapshot and logs a warning so the server remains stable.
 *   - Non-blocking: Triggers rebuild in the background so request latency is never stalled.
 *   - Disposal: Once disposed, no rebuild starts and a rebuild already in flight
 *     can no longer publish, so nothing outlives the server that owned the manager.
 */

import type { ViewerSnapshot } from "./types.js";
import { buildViewerSnapshot } from "./snapshot.js";

/** Default minimum interval in milliseconds between on-request snapshot rebuilds. */
export const DEFAULT_REFRESH_INTERVAL_MS = 5_000;

/** Lower bound on the refresh interval to avoid excessive rebuilds on disk. */
export const MIN_REFRESH_INTERVAL_MS = 1_000;

/** Options for configuring the snapshot manager. */
export interface SnapshotManagerOptions {
  /** Absolute project root. When missing, dynamic refreshing is disabled. */
  root?: string;
  /**
   * Interval in milliseconds between rebuilds.
   * When omitted or <= 0, dynamic refresh is disabled.
   * Positive values are clamped to at least MIN_REFRESH_INTERVAL_MS (1,000 ms).
   * Non-finite values (NaN, Infinity) throw a TypeError.
   */
  refreshIntervalMs?: number;
  /** Snapshot builder function. Defaults to `buildViewerSnapshot`. */
  buildSnapshot?: (root: string) => Promise<ViewerSnapshot>;
  /** Injectable clock returning epoch milliseconds (defaults to Date.now). */
  now?: () => number;
}

export class ViewerSnapshotManager {
  private currentSnapshot: ViewerSnapshot;
  private readonly root: string | undefined;
  private readonly refreshIntervalMs: number;
  private readonly enabled: boolean;
  private readonly buildSnapshot: (root: string) => Promise<ViewerSnapshot>;
  private readonly now: () => number;
  private lastRebuildTime: number;
  private inFlightRebuild: Promise<void> | null = null;
  private isDisposed = false;

  constructor(initialSnapshot: ViewerSnapshot, options: SnapshotManagerOptions = {}) {
    this.currentSnapshot = initialSnapshot;
    this.root = options.root ?? initialSnapshot.root;
    this.now = options.now ?? Date.now;
    this.buildSnapshot = options.buildSnapshot ?? buildViewerSnapshot;

    const interval = options.refreshIntervalMs;
    if (interval !== undefined) {
      if (!Number.isFinite(interval)) {
        throw new TypeError(`refreshIntervalMs must be a finite number, received ${interval}`);
      }
      if (interval <= 0) {
        this.enabled = false;
        this.refreshIntervalMs = 0;
      } else {
        this.enabled = Boolean(this.root);
        this.refreshIntervalMs = Math.max(interval, MIN_REFRESH_INTERVAL_MS);
      }
    } else {
      this.enabled = false;
      this.refreshIntervalMs = 0;
    }

    this.lastRebuildTime = this.now();
  }

  /** Retrieve the currently held snapshot without triggering a rebuild check. */
  getCurrentSnapshot(): ViewerSnapshot {
    return this.currentSnapshot;
  }

  /**
   * Acquire a snapshot for request dispatch.
   *
   * Triggers a background rebuild if dynamic refresh is enabled, the refresh
   * interval has elapsed, and no rebuild is already in flight.
   * Requests always receive the current snapshot immediately without waiting
   * for the rebuild to complete.
   */
  async getSnapshot(): Promise<ViewerSnapshot> {
    if (this.isRebuildDue()) {
      this.inFlightRebuild = this.rebuild(this.root!);
    }
    return this.currentSnapshot;
  }

  /**
   * Stop refreshing for good. Resolves once any rebuild already in flight has
   * settled; that rebuild's result is discarded rather than published, because
   * the build itself cannot be cancelled midway.
   */
  async dispose(): Promise<void> {
    this.isDisposed = true;
    await this.inFlightRebuild;
  }

  /** True when a request should start a background rebuild. */
  private isRebuildDue(): boolean {
    if (this.isDisposed || !this.enabled || !this.root) return false;
    if (this.inFlightRebuild !== null) return false;
    return this.now() - this.lastRebuildTime >= this.refreshIntervalMs;
  }

  /** Build a fresh snapshot and publish it unless the manager was disposed meanwhile. */
  private async rebuild(root: string): Promise<void> {
    try {
      const next = await this.buildSnapshot(root);
      if (this.isDisposed) return;
      this.publish(next, root);
    } catch (err) {
      if (this.isDisposed) return;
      console.warn("viewer snapshot rebuild failed, retaining previous snapshot:", err);
    } finally {
      this.lastRebuildTime = this.now();
      this.inFlightRebuild = null;
    }
  }

  /** Swap in a rebuilt snapshot, refusing one built for a different root. */
  private publish(next: ViewerSnapshot, root: string): void {
    if (!next) return;
    if (next.root !== root) {
      console.warn(
        `viewer snapshot rebuild returned mismatched root (expected "${root}", got "${next.root}"); retaining previous snapshot`,
      );
      return;
    }
    this.currentSnapshot = next;
  }
}
