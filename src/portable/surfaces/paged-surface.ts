/**
 * @file src/portable/surfaces/paged-surface.ts
 * @description How a non-SDK surface (the CLI, the viewer, MCP) reaches the
 * paged reads of a portable project.
 *
 * It follows the version 1 surface beside it: configured once with HOW to open
 * a session and nothing else, it opens a session for each call, so every
 * request is decided against current host state. It takes the paged reads the
 * session negotiated; a session that negotiated none gets a refusal naming the
 * protocol, never a fallback that collects version 1's listing.
 *
 * A session that can no longer be opened at all, because its principal has no
 * binding left, is the same generic `permission_denied` any paged method gives.
 */

import { ACCESS_NOTICE } from "../contracts.js";
import { PortableDenied } from "../errors.js";
import type {
  ListPageRequestV2, PagedListOutcomeV2, PagedOpenOutcomeV2, PagedProjectV2, PagedRefusedV2,
  PagedSearchOutcomeV2, ScaleNegotiationOutcomeV2, SearchPageRequestV2,
} from "../scale/contracts.js";
import { pagedOf } from "../scale/open.js";
import type { OpenSession } from "./surface.js";

/** The paged reads a surface may offer. All are reads; none changes anything. */
export interface PagedSurface {
  negotiate(): Promise<ScaleNegotiationOutcomeV2>;
  listPage(request?: ListPageRequestV2): Promise<PagedListOutcomeV2>;
  openPage(id: string): Promise<PagedOpenOutcomeV2>;
  search(request: SearchPageRequestV2): Promise<PagedSearchOutcomeV2>;
}

const DENIED: PagedRefusedV2 = { kind: "refused", code: "permission_denied", notice: ACCESS_NOTICE };

/** Bind the paged surface operations to a way of opening sessions. */
export function pagedSurface(open: OpenSession): PagedSurface {
  /** Open a session for ONE paged read and close it afterwards, whatever happens. */
  const using = async <T>(read: (paged: PagedProjectV2) => Promise<T>): Promise<T | PagedRefusedV2> => {
    try {
      const session = await open();
      try {
        return await read(pagedOf(session));
      } finally {
        await session.close();
      }
    } catch (error) {
      if (error instanceof PortableDenied) return DENIED;
      throw error;
    }
  };
  return {
    negotiate: () => using((paged) => paged.negotiate()),
    listPage: (request) => using((paged) => paged.pages.listPage(request)),
    openPage: (id) => using((paged) => paged.pages.open(id)),
    search: (request) => using((paged) => paged.search(request)),
  };
}
