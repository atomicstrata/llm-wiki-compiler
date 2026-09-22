/**
 * @file src/capability-providers/constants.ts
 * @description Named Provider V2 identity and section 26 hard ceilings. Each
 * exported name states its unit so parsers, package, protocol, broker, and
 * sandbox code avoid copying anonymous byte, count, time, or cost values.
 */
const MEBIBYTE_BYTES = 1024 ** 2;
const GIBIBYTE_BYTES = 1024 ** 3;
const SECOND_MILLISECONDS = 1_000;
const MINUTE_MILLISECONDS = 60 * SECOND_MILLISECONDS;
const HOUR_MILLISECONDS = 60 * MINUTE_MILLISECONDS;

/** Maximum UTF-8 bytes in one provider-coordinate slug component. */
export const MAX_PROVIDER_COORDINATE_COMPONENT_BYTES = 128;
/** Maximum UTF-8 bytes in one path-facing logical identity. */
export const MAX_PROVIDER_LOGICAL_ID_BYTES = 128;
/** Maximum identities copied into one host-owned logical-ID snapshot. */
export const MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS = 4_096;
/** Maximum UTF-8 bytes in one exact semantic version. */
export const MAX_PROVIDER_SEMANTIC_VERSION_BYTES = 256;
/** Maximum UTF-8 bytes in one exact opaque capability contract version. */
export const MAX_CAPABILITY_CONTRACT_VERSION_BYTES = 256;
/** Maximum UTF-8 bytes in one complete provider coordinate. */
export const MAX_PROVIDER_COORDINATE_BYTES = 1_024;

/** Maximum UTF-8 bytes in one signed provider envelope or schema document. */
export const MAX_SIGNED_PROVIDER_ENVELOPE_BYTES = 4 * MEBIBYTE_BYTES;
/** Maximum compressed bytes in one platform artifact. */
export const MAX_COMPRESSED_PLATFORM_ARTIFACT_BYTES = 512 * MEBIBYTE_BYTES;
/** Maximum bytes in one expanded provider package tree. */
export const MAX_EXPANDED_PACKAGE_TREE_BYTES = 2 * GIBIBYTE_BYTES;
/** Maximum filesystem entries in one provider package. */
export const MAX_PACKAGE_ENTRIES = 50_000;
/** Maximum bytes in one expanded provider package entry. */
export const MAX_PACKAGE_ENTRY_BYTES = 512 * MEBIBYTE_BYTES;
/** Maximum declared capabilities in one provider manifest. */
export const MAX_MANIFEST_CAPABILITIES = 256;

/** Maximum bytes in one structured provider input. */
export const MAX_STRUCTURED_INPUT_BYTES = 2 * MEBIBYTE_BYTES;
/** @expected-unused Provider input consumers land in later plan tasks. */
export const MAX_STRUCTURED_INPUT_DEPTH = 32;
/** @expected-unused Provider input consumers land in later plan tasks. */
export const MAX_STRUCTURED_INPUT_MEMBERS = 4_096;
/** Maximum files materialized for one provider invocation. */
export const MAX_MATERIALIZED_INPUT_FILES = 4_096;
/** Maximum aggregate bytes materialized for one provider invocation. */
export const MAX_MATERIALIZED_INPUT_BYTES = 8 * GIBIBYTE_BYTES;
/** Maximum bytes in one materialized provider input file. */
export const MAX_MATERIALIZED_INPUT_FILE_BYTES = 2 * GIBIBYTE_BYTES;
/** Maximum scratch bytes for one provider invocation. */
export const MAX_SCRATCH_BYTES = 16 * GIBIBYTE_BYTES;
/** Maximum scratch entries for one provider invocation. */
export const MAX_SCRATCH_ENTRIES = 8_192;
/** Maximum accepted output files for one provider invocation. */
export const MAX_ACCEPTED_OUTPUT_FILES = 2_048;
/** Maximum accepted output bytes for one provider invocation. */
export const MAX_ACCEPTED_OUTPUT_BYTES = 8 * GIBIBYTE_BYTES;
/** @expected-unused Provider output consumers land in later plan tasks. */
export const MAX_ACCEPTED_OUTPUT_FILE_BYTES = 2 * GIBIBYTE_BYTES;
/** Maximum bytes scanned while recustodying provider outputs. */
export const MAX_CUSTODY_SCAN_BYTES = 16 * GIBIBYTE_BYTES;
/** Maximum wall time for provider output recustody. */
export const MAX_CUSTODY_WALL_TIME_MS = 30 * MINUTE_MILLISECONDS;
export const MAX_PROTOCOL_FRAME_BYTES = MEBIBYTE_BYTES;
/** Maximum protocol frames in either stream direction. */
export const MAX_PROTOCOL_STREAM_FRAMES = 16_384;
/** Maximum protocol bytes in either stream direction. */
export const MAX_PROTOCOL_STREAM_BYTES_PER_DIRECTION = 64 * MEBIBYTE_BYTES;
/** Maximum advisory progress frames one provider invocation may emit. */
export const MAX_PROGRESS_MESSAGES = 4_096;
/** @expected-unused Provider runtime consumers land in later plan tasks. */
export const MAX_PROVIDER_STDERR_RETAINED_BYTES = 8 * MEBIBYTE_BYTES;
/** Maximum wall time for one provider invocation. */
export const MAX_PROVIDER_WALL_TIME_MS = 12 * HOUR_MILLISECONDS;
/** Maximum CPU time for one provider invocation. */
export const MAX_PROVIDER_CPU_TIME_MS = 48 * HOUR_MILLISECONDS;
/** Maximum memory for one provider invocation. */
export const MAX_PROVIDER_MEMORY_BYTES = 16 * GIBIBYTE_BYTES;
/** Maximum processes for one provider invocation. */
export const MAX_PROVIDER_PROCESSES = 128;
/** @expected-unused Provider runtime consumers land in later plan tasks. */
export const MAX_PROVIDER_THREADS = 256;
/** @expected-unused Provider runtime consumers land in later plan tasks. */
export const MAX_PROVIDER_OPEN_FILES = 512;
/** Maximum broker requests for one provider invocation. */
export const MAX_BROKER_REQUESTS = 4_096;
/** Maximum HTTPS requests for one provider invocation. */
export const MAX_HTTPS_REQUESTS = 2_048;
/** Maximum encoded or decoded bytes in one provider HTTPS request or response. */
export const MAX_HTTPS_REQUEST_OR_RESPONSE_BYTES = 64 * MEBIBYTE_BYTES;
/** Maximum aggregate provider HTTPS transfer bytes for one invocation. */
export const MAX_HTTPS_AGGREGATE_TRANSFER_BYTES = 4 * GIBIBYTE_BYTES;
/** Maximum redirects followed by one provider HTTPS request. */
export const MAX_HTTPS_REDIRECTS_PER_REQUEST = 5;
/** Maximum model calls for one provider invocation. */
export const MAX_MODEL_CALLS = 2_048;
/** Maximum aggregate model tokens for one provider invocation. */
export const MAX_MODEL_AGGREGATE_TOKENS = 20_000_000;
/** Maximum aggregate billable model cost for one provider invocation. */
export const MAX_MODEL_AGGREGATE_BILLABLE_COST_USD = 100;
/** Maximum registered command calls for one provider invocation. */
export const MAX_COMMANDS = 256;
/** Maximum wall time for one registered command. */
export const MAX_COMMAND_WALL_TIME_MS = 2 * HOUR_MILLISECONDS;
/** Maximum aggregate accepted command bytes for one provider invocation. */
export const MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES = 2 * GIBIBYTE_BYTES;
/** Maximum mutating effects for one provider invocation. */
export const MAX_MUTATING_EFFECTS = 256;
export const MAX_MUTATING_EFFECTS_PER_CLASS = 64;

/**
 * Host aggregate ceilings for the four per-broker tightenable maxima. These
 * dimensions never live in the frozen closed `ProviderBoundsV1`; a signed
 * broker requirement, operations pack, or operator grant may only tighten
 * them, never widen them beyond the named ceiling.
 */
export const BROKER_AGGREGATE_MAXIMUM_CEILINGS = Object.freeze({
  httpsTransferBytes: MAX_HTTPS_AGGREGATE_TRANSFER_BYTES,
  modelTokens: MAX_MODEL_AGGREGATE_TOKENS,
  modelCostUsd: MAX_MODEL_AGGREGATE_BILLABLE_COST_USD,
  commandAcceptedBytes: MAX_COMMAND_AGGREGATE_ACCEPTED_BYTES,
} as const);
/** Ordered names of the four per-broker tightenable aggregate maxima. */
export const BROKER_AGGREGATE_MAXIMUM_KEYS = Object.freeze(
  Object.keys(BROKER_AGGREGATE_MAXIMUM_CEILINGS) as ReadonlyArray<
    keyof typeof BROKER_AGGREGATE_MAXIMUM_CEILINGS
  >,
);
