/** Shared content transport rules for the read-only source/artifact routes. */
import type { ServerResponse } from "http";
import { writeJson, writeJsonError } from "./respond.js";

/** Send metadata without the private content slot, including on loopback. */
export function writeAccessMetadata(res: ServerResponse, result: Record<string, unknown>): void {
  const { body: _body, ...metadata } = result;
  writeJson(res, 200, metadata);
}

/** Byte access fails closed independently of the preceding metadata request. */
export function writeAccessContent(res: ServerResponse, result: Record<string, unknown>, filename: string, download: boolean): void {
  if (result.contentAccess !== "available") {
    writeJsonError(res, 403, "loopback_required", "Content is available only on a loopback binding.");
  } else if (result.health !== "ok" || typeof result.body !== "string") {
    writeJsonError(res, 409, "content_unavailable", "Content did not pass its current read checks.");
  } else {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.end(result.body);
  }
}
