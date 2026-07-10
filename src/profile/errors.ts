/**
 * Profile validation error type.
 *
 * Extracted into its own module so both the ajv structural validator
 * (`schema-validator.ts`) and the semantic validator (`validate.ts`) can throw
 * the same error type without a circular import between them.
 */

/** Error raised when a raw profile violates any v0 invariant. */
export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileValidationError";
  }
}
