/**
 * @file src/utils/directory-sync-scope.ts
 * @description An opt-in memo that lets ONE locked batch of strict create-only
 * publications skip re-fsyncing ancestor directories whose entries an earlier
 * write in the same batch already made durable.
 *
 * `fsyncDirectoryChain` persists every directory entry from a write's leaf
 * parent up to the confined project root. Within a batch, the leaf parent
 * changes on every write (link/unlink), but the ancestors above it normally do
 * not, so re-syncing them repeats work without persisting anything new. A
 * scope records ANCHORED identity chains: a chain `D → … → root` (canonical
 * path, dev and inode of every directory on it) is anchored only after a walk
 * completed in which each directory's entry in its parent was persisted by an
 * fsync made while that exact chain existed. A later walk may stop syncing at
 * an ancestor only when the freshly observed chain from the child below it up
 * to the root equals an anchored chain. Comparing the WHOLE chain means a
 * previously synced subtree reparented under a recreated higher directory at
 * the same lexical path is a mismatch, and the walk syncs everything again.
 *
 * Lifetime and binding: a scope belongs to one prepared batch under one held
 * project lock, is bound to one canonical root, and is retired when the batch
 * ends; using a retired or foreign-root scope throws. A scope never skips the
 * leaf-parent fsync, never records an anchor for a failed sync, and changes no
 * on-disk format. Residual (same class as the existing portable same-UID
 * bound): a same-UID actor that renames a directory away and back between two
 * writes of one locked batch, keeping its inode, is not detected by identity.
 */

/** Identity of one directory on a sync chain. */
export interface DirectoryIdentity {
  /** Canonical (realpath) location. */
  realDir: string;
  dev: number;
  ino: number;
}

/** Stable key for an identity chain ordered from a directory up to the root. */
function chainKey(chain: readonly DirectoryIdentity[]): string {
  return JSON.stringify(chain.map((d) => [d.realDir, d.dev, d.ino]));
}

/** One batch's anchored directory chains (see file header). */
export class DirectorySyncScope {
  private readonly anchored = new Set<string>();
  private retired = false;

  /**
   * @param realRoot - Canonical project root every write in this batch is confined under.
   */
  constructor(readonly realRoot: string) {}

  /**
   * Fail closed unless the scope is live and bound to this write's root.
   *
   * @param realRoot - The canonical root of the write about to use the scope.
   */
  assertUsableFor(realRoot: string): void {
    if (this.retired) throw new Error("directory sync scope is retired");
    if (realRoot !== this.realRoot) throw new Error("directory sync scope is bound to another project root");
  }

  /** True when exactly this chain (child up to root) was anchored in this scope. */
  isAnchored(chain: readonly DirectoryIdentity[]): boolean {
    return this.anchored.has(chainKey(chain));
  }

  /**
   * Anchor a fully persisted chain (leaf parent up to root) and, with it, every
   * suffix of that chain: each directory's entry in its parent is durable.
   */
  anchor(chain: readonly DirectoryIdentity[]): void {
    for (let i = 0; i < chain.length; i++) this.anchored.add(chainKey(chain.slice(i)));
  }

  /** End the batch: later use throws, so a scope can never outlive its lock hold. */
  retire(): void {
    this.retired = true;
    this.anchored.clear();
  }
}
