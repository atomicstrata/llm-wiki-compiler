/**
 * @file src/portable/scale/v1-adapter.ts
 * @description The bounded compatibility adapter that lets a VERSION 1 store
 * stand behind the new paged interface without pretending to be one.
 *
 * It declares what it is: array listing, no stat without a read, no index, and
 * version 1's own caps. `stat` and `open` work, each as one bounded
 * whole-object read through the store's consistent read view, so a single page
 * can still be opened on any backend. `listPage` REFUSES
 * `capability_unsupported`, naming the capability. It never lists every name
 * and slices: that would be the array listing with a cursor-shaped signature,
 * which is exactly what this adapter exists to prevent.
 */

import { PortableRefusal } from "../errors.js";
import type { ProjectStore } from "../store/store.js";
import type { AdapterScaleCapabilitiesV2 } from "./contracts.js";
import { isPagedStore, type PagedReadView } from "./paged-store.js";

/** What a version 1 store declares at scale: nothing it does not have. */
function v1CompatCapabilities(store: ProjectStore): AdapterScaleCapabilitiesV2 {
  return {
    listing: "array", listFence: "none", statWithoutRead: "none", keywordIndex: "none", labelEpoch: "none",
    custody: "v1-compatibility",
    limits: {
      // The version 1 cap, restated. It bounds version 1's own array listing; no paged listing exists here.
      defaultPageSize: store.capabilities.limits.maxListPage, maxPageSize: store.capabilities.limits.maxListPage,
      defaultSearchLimit: 0, maxSearchLimit: 0, maxQueryTerms: 0, scanBudget: 0,
    },
  };
}

/** A version 1 store behind the paged interface, bounded and honest about it. */
function v1CompatPagedView(store: ProjectStore): PagedReadView {
  return {
    // No stat without a read here: the whole object is observed to learn its digest.
    stat: (path) => store.withReadView(async (view) => {
      const seen = await view.observe(path);
      if (seen === null) return null;
      const labels = (await view.labelsFor(path, seen.digest)) ?? [];
      return { path, digest: seen.digest, byteCount: seen.bytes.byteLength, revision: seen.revision, labels, title: path };
    }),
    open: (path) => store.withReadView((view) => view.read(path)),
    listPage: async () => {
      throw new PortableRefusal("capability_unsupported", "listing:cursor");
    },
  };
}

/** The paged view of any store: the real one, or the bounded adapter. */
export function pagedViewOf(store: ProjectStore): PagedReadView {
  return isPagedStore(store) ? store.pagedView() : v1CompatPagedView(store);
}

/** What any store declares at scale. */
export function scaleCapabilitiesOf(store: ProjectStore): AdapterScaleCapabilitiesV2 {
  return isPagedStore(store) ? store.scaleCapabilities : v1CompatCapabilities(store);
}
