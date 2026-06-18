import { describe, it, expect } from "vitest";
import {
  EmbeddingIntegrityError,
  isIntegrityError,
  isAuthError,
  isRequestTooLarge,
  isTransient,
} from "../src/utils/embeddings-batch.js";

const withStatus = (status: number, message = "") => Object.assign(new Error(message), { status });

describe("error taxonomy", () => {
  it("classifies each error class", () => {
    expect(isIntegrityError(new EmbeddingIntegrityError("cardinality"))).toBe(true);
    expect(isAuthError(withStatus(401))).toBe(true);
    expect(isAuthError(new Error("VOYAGE_API_KEY is not set"))).toBe(true);
    expect(isRequestTooLarge(withStatus(413))).toBe(true);
    expect(isRequestTooLarge(withStatus(400, "max allowed tokens per request"))).toBe(true);
    expect(isTransient(withStatus(429))).toBe(true);
    expect(isTransient(withStatus(503))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    // a plain 400 with no size hint is NOT oversized — treat as caller error
    expect(isRequestTooLarge(withStatus(400, "bad input"))).toBe(false);
  });
});
