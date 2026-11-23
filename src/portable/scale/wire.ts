/**
 * @file src/portable/scale/wire.ts
 * @description The wire names of the paged protocol, shared by the simulated
 * host and its client.
 *
 * They are SEPARATE from version 1's wire: a different path prefix, their own
 * closed method list, and a header in which the client states the protocol it
 * speaks. `REMOTE_METHODS` is not extended. A request that does not state the
 * protocol never reaches a paged method; it gets the same not-found any
 * unknown version 1 method gets, so a version 1 client cannot stumble into a
 * shape or a refusal code it does not know.
 */

/** The path prefix of the paged methods. Version 1 stays under `/v1/`. */
export const SCALE_PATH_PREFIX = "/v2/";

/** The request header in which a client states the protocols it speaks, comma-separated. */
export const SCALE_PROTOCOL_HEADER = "x-llmwiki-portable-protocol";

/** Every paged method a client may name. */
const SCALE_REMOTE_METHODS_V2 = ["negotiate", "pages.listPage", "pages.open", "search"] as const;

/** One of the closed paged methods. */
export type ScaleRemoteMethodV2 = (typeof SCALE_REMOTE_METHODS_V2)[number];
