/**
 * Provider-neutral embedding response validation. Imports NOTHING from
 * provider.ts — this leaf module is depended on by both the providers and the
 * batch helper, so the provider → openai → batch → provider cycle can't form.
 * Validation functions are added in Task 8.
 */

/** Provider returned structurally invalid data (count, shape, dimension, index). */
export class EmbeddingIntegrityError extends Error {
  constructor(message: string) {
    super(`Embedding integrity error: ${message}`);
    this.name = "EmbeddingIntegrityError";
  }
}
