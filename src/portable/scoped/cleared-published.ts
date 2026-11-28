/**
 * @file src/portable/scoped/cleared-published.ts
 * @description The one clearance-checked read the scoped path's review reads
 * share: the object a proposal's commit published, served only to a caller
 * cleared for the labels it was committed under. It reads through a view and
 * the bound authority; it names no store implementation.
 */

import type { PublishedObject } from "../contracts.js";
import type { ReadView } from "../store/store.js";
import type { ProjectRuntime } from "../project/runtime.js";
import { scopedAuthority, SCOPED_VERBS } from "./scoped-authority.js";

/**
 * The object a proposal's commit published at `path`, when the caller is
 * cleared for the labels it was committed under — decided BEFORE the stored
 * record is read — or `null`.
 */
export async function clearedPublished(
  runtime: ProjectRuntime, view: ReadView, proposalOperationId: string, path: string,
): Promise<PublishedObject | null> {
  const published = (await view.getReceipt(proposalOperationId))?.published.find((object) => object.path === path);
  if (published === undefined || (await scopedAuthority(runtime, SCOPED_VERBS.read, published.labels)) === null) return null;
  return published;
}
