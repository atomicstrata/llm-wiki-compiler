/**
 * @file src/operations-packs/constants.ts
 * @description WOP V3 operations-pack collection ceilings, closed-grammar length
 * caps, and the reserved-identifier set (design sections 7.5, 10, 11, 14, 19).
 * Byte ceilings for whole documents are owned by {@link ../products/constants}
 * and imported where needed so a single-root pack and its composition lock share
 * one limit; this file adds only the caps introduced by the operations-pack
 * grammar itself. Count limits name the counted resource; byte limits carry a
 * `BYTES` suffix so bounds arithmetic never mixes units.
 */

// --- Section 10/11/14/19 collection ceilings -----------------------------

/** Maximum actions declared in one operations pack. */
export const MAX_PACK_ACTIONS = 1_024;

/** Maximum recipes declared in one operations pack. */
export const MAX_PACK_RECIPES = 1_024;

/** Maximum aliases declared in one operations pack. */
export const MAX_PACK_ALIASES = 1_024;

/**
 * The evidence-item identity the frozen action input decodes to at runtime.
 * RESERVED: a logical phase publishing under its own id would collide with this
 * identity when chained beside the real action input, so no recipe phase may
 * claim it. The compiler enforces the reservation for every compile path.
 */
export const RESERVED_EVIDENCE_ITEM_ID = "action-input";

/**
 * The evidence-item identity PREFIX a multi-source action input decodes under
 * (`source-0`, `source-1`, …). RESERVED for the same reason as the exact id
 * above: a logical phase named `source-<i>` would publish a wrapped item whose
 * identity collides with a list item's, and intent's first-arrival dedupe would
 * silently drop one of them. The compiler refuses the whole prefix.
 */
export const RESERVED_EVIDENCE_ITEM_ID_PREFIX = "source-";

/** Maximum render templates declared in one operations pack (section 16.5). */
export const MAX_PACK_RENDER_TEMPLATES = 256;

/** Maximum nodes one render template may carry, counted across all nesting. */
export const MAX_RENDER_TEMPLATE_NODES = 512;

/** Maximum nesting depth of a render template's each/when-present bodies. */
export const MAX_RENDER_NODE_DEPTH = 8;

/** Maximum UTF-8 bytes of one render template literal segment. */
export const MAX_RENDER_LITERAL_BYTES = 8_192;

/** Maximum provider requirements declared in one operations pack. */
export const MAX_PROVIDER_REQUIREMENTS = 256;

/** Maximum allowed or fallback provider pins named by one provider requirement. */
export const MAX_REQUIREMENT_PROVIDER_PINS = 256;

/** Maximum input fields declared in one action input schema. */
export const MAX_ACTION_INPUT_FIELDS = 128;

/** Maximum phases declared in one recipe. */
export const MAX_RECIPE_PHASES = 256;

/** Maximum completeness-class rows declared in one recipe. */
export const MAX_RECIPE_COMPLETENESS_CLASSES = 256;

/** Maximum declared fields in one recipe input or output contract. */
export const MAX_RECIPE_CONTRACT_FIELDS = 256;

/** Maximum registered format ids one recipe output contract may declare. */
export const MAX_RECIPE_FORMAT_IDS = 64;

/** Maximum prior phases one phase may depend on. */
export const MAX_PHASE_DEPENDENCIES = 256;

/** Maximum input bindings or declared output fields on one phase. */
export const MAX_PHASE_FIELDS = 128;

/** Maximum registered rule bindings one validate phase may evaluate. */
export const MAX_PHASE_RULE_BINDINGS = 256;

/** Maximum closed scalar parameters one registered rule binding may carry. */
export const MAX_RULE_PARAMETERS = 128;

/** Maximum closed field mappings one intent phase body may declare. */
export const MAX_INTENT_FIELD_MAPPINGS = 256;

/** Maximum intent groups one intent phase body may declare. */
// 12: the single terminal intent phase the compiler admits must carry one
// group per page class AND per relation type — §4.4's topology is five page
// classes plus four relation types, and 8 refused it at the emitter.
export const MAX_INTENT_GROUPS = 12;

/**
 * Control characters (C0 and C1, plus DEL) pack-authored TEXT may not carry;
 * `\n` and `\t` excepted. The ONE content rule for every pack-authored string
 * (render template literals, intent string constants) so the two cannot drift.
 */
// eslint-disable-next-line no-control-regex
export const FORBIDDEN_PACK_TEXT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/** Maximum finding classes one reconcile phase body may emit. */
export const MAX_RECONCILE_FINDING_CLASSES = 16;

/** Maximum entries in one bounded closed string-set (enum values, allowed types). */
export const MAX_CLOSED_STRING_SET = 256;

/** Maximum default-value list items an alias or field default may carry. */
export const MAX_DEFAULT_VALUE_ITEMS = 256;

/** Maximum resolved-export rows one flattened export table may hold. */
export const MAX_FLATTENED_EXPORTS = 4_096;

/** Maximum member rows one composition lock may declare. */
export const MAX_COMPOSITION_MEMBERS = 256;

// --- Section 10/14/19 closed-grammar length caps -------------------------

/** Maximum UTF-8 bytes in one pack id. */
export const MAX_PACK_ID_BYTES = 128;
/** Maximum UTF-8 bytes in one qualified dotted action or recipe id. */
export const MAX_QUALIFIED_ID_BYTES = 160;
/** Maximum UTF-8 bytes in one slug identifier (alias id, token, role id, tag). */
export const MAX_SLUG_ID_BYTES = 96;
/** Maximum UTF-8 bytes in one dotted-optional reference identifier. */
export const MAX_REF_ID_BYTES = 160;
/** Maximum UTF-8 bytes in one localized message key. */
export const MAX_MESSAGE_KEY_BYTES = 160;
/** Maximum UTF-8 bytes in one bounded default string value. */
export const MAX_DEFAULT_STRING_BYTES = 4_096;

// --- Section 14.1/19.2 reserved identifiers ------------------------------

/**
 * The core-command, recovery, and review verbs a pack action, recipe, alias id,
 * or alias token can never claim (section 14.1, 19.2). The check compares both a
 * qualified id's first dotted segment and its full text against this set so a
 * product cannot shadow generic dispatch. This is a closed launch set; a dated
 * revision extends it rather than a runtime probe of the live CLI.
 */
export const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  "help", "version", "status", "init", "config",
  "workspace", "product", "products", "pack", "packs",
  "action", "actions", "alias", "aliases", "recipe", "recipes",
  "provider", "providers", "install", "uninstall", "update",
  "activate", "deactivate", "rollback", "gc",
  "recover", "recovery", "resume", "cancel", "abort",
  "review", "approve", "reject", "confirm",
]);
