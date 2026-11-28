/**
 * @file src/portable/scoped-disk/disk-tail.ts
 * @description The derived index and Map of Content after a disk scoped
 * apply: a best-effort tail written after the receipt, outside the batch and
 * outside every dependency. Never compile state — that is published in the
 * batch, as an authoritative target.
 *
 * They are rebuilt WHOLE, with the shared builders a local compile uses, from
 * every concept and query page as it will be once the apply's pages land. That
 * cost is proportional to the whole wiki and is stated, not hidden.
 *
 * AUTHORIZED INPUTS. The applier must be currently cleared to read every
 * input page before any reaches a builder; otherwise the rebuild is declined.
 *
 * LABELS NEVER GO DOWN. A derived view says something about every page it
 * lists, so it carries the union of every input page's labels, its own
 * current labels, and the apply's own (which include the project compartment,
 * so a page a legacy writer never bound is covered as the reconciliation
 * would cover it). When a
 * binding is damaged, or the inputs exceed the disk envelope, the rebuild is
 * declined and the previous views stay as they are, to be rebuilt later; the
 * commit is never doubted for it.
 */

import { indexContentFromPages, type PageText } from "../../compiler/indexgen.js";
import { mocContentFromPages } from "../../compiler/obsidian.js";
import type { ContentDigest, LabelSet } from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import { CONCEPTS_PREFIX, INDEX_PATH, MOC_PATH, QUERIES_PREFIX } from "../logical-paths.js";
import type { ProjectRuntime } from "../project/runtime.js";
import { scopedAuthority, SCOPED_VERBS } from "../scoped/scoped-authority.js";
import type { DiskProjectStore } from "../store/disk-store.js";
import type { StoredWrite, TailWrite } from "../store/store.js";
import { DISK_SCOPED_CEILINGS } from "./disk-contracts.js";

const UTF8 = new TextDecoder("utf-8");

/** The input pages gathered so far, with every label they carry and their total bytes. */
interface Inputs { labels: Set<string>; bytes: number; count: number }

/** The labels bound to one stored page now: its exact binding, else its latest one, else none beyond the apply's. */
async function storedLabels(store: DiskProjectStore, path: string, digest: ContentDigest): Promise<LabelSet> {
  return (await store.labelsFor(path, digest)) ?? (await store.lastLabels(path)) ?? [];
}

/** One page as it will be after the apply: this apply's write, else what is stored now; `null` when absent. */
async function pageAfter(store: DiskProjectStore, path: string, write: StoredWrite | undefined): Promise<{ bytes: Uint8Array; labels: LabelSet } | null> {
  if (write !== undefined) return { bytes: write.bytes, labels: write.labels };
  const seen = await store.observe(path);
  return seen === null ? null : { bytes: seen.bytes, labels: await storedLabels(store, path, seen.digest) };
}

/** Every Markdown page under `prefix` after the apply, or `null` when the disk envelope is exceeded. */
async function pagesAfter(store: DiskProjectStore, prefix: string, writes: readonly StoredWrite[], into: Inputs): Promise<PageText[] | null> {
  const written = new Map(writes.filter((write) => write.path.startsWith(prefix)).map((write) => [write.path, write]));
  const paths = [...new Set([...(await store.list(prefix)), ...written.keys()])].filter((path) => path.endsWith(".md")).sort();
  into.count += paths.length;
  if (into.count > DISK_SCOPED_CEILINGS.maxTitleEntries) return null;
  const pages: PageText[] = [];
  for (const path of paths) {
    const page = await pageAfter(store, path, written.get(path));
    if (page === null) continue;
    const { bytes, labels } = page;
    into.bytes += bytes.byteLength;
    if (into.bytes > DISK_SCOPED_CEILINGS.maxReadBytes) return null;
    for (const label of labels) into.labels.add(label);
    pages.push({ slug: path.slice(prefix.length, -".md".length), content: UTF8.decode(bytes) });
  }
  return pages;
}

/** A derived view's labels: its inputs' union, never fewer than the view itself carries now (exact binding, else latest). */
async function viewLabels(store: DiskProjectStore, path: string, inputs: ReadonlySet<string>): Promise<LabelSet> {
  const seen = await store.observe(path);
  const own = seen === null ? (await store.lastLabels(path)) ?? [] : await storedLabels(store, path, seen.digest);
  return normalizeLabels([...inputs, ...own]);
}

/**
 * The index and MOC from the gathered pages, or nothing when the rebuild is
 * declined. The applier must be CURRENTLY cleared to read every input — the
 * union of their labels — before any of it is handed to a builder.
 */
async function rebuilt(runtime: ProjectRuntime, store: DiskProjectStore, writes: readonly StoredWrite[], labels: LabelSet): Promise<TailWrite[]> {
  const inputs: Inputs = { labels: new Set(labels), bytes: 0, count: 0 };
  const concepts = await pagesAfter(store, CONCEPTS_PREFIX, writes, inputs);
  const queries = concepts === null ? null : await pagesAfter(store, QUERIES_PREFIX, writes, inputs);
  if (concepts === null || queries === null) return [];
  if ((await scopedAuthority(runtime, SCOPED_VERBS.view, normalizeLabels([...inputs.labels]))) === null) return [];
  return [
    { path: INDEX_PATH, bytes: Buffer.from(indexContentFromPages(concepts, queries), "utf8"), labels: await viewLabels(store, INDEX_PATH, inputs.labels) },
    { path: MOC_PATH, bytes: Buffer.from(mocContentFromPages(concepts), "utf8"), labels: await viewLabels(store, MOC_PATH, inputs.labels) },
  ];
}

/**
 * The tail of one disk scoped apply: the index and MOC rebuilt whole, each
 * carrying the union of its inputs' labels, `labels` and its own current
 * labels, or nothing when the rebuild is declined.
 */
export async function diskDerivedTail(
  runtime: ProjectRuntime, store: DiskProjectStore, writes: readonly StoredWrite[], labels: LabelSet,
): Promise<TailWrite[]> {
  // A damaged label binding or an unreadable page declines the rebuild; it never refuses the apply.
  const tail = await rebuilt(runtime, store, writes, labels).catch(() => []);
  // A view too large for one object would refuse the whole publication: it is declined instead.
  return tail.every((item) => item.bytes.byteLength <= store.capabilities.limits.maxObjectBytes) ? tail : [];
}
