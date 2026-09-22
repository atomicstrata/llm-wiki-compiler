/**
 * @file test/preparations/lifecycle-model/structural-controls.test.ts
 * @description Structural convergence controls over the preparation lifecycle.
 *
 * WHAT THESE PROVE: module inventory closure and import ownership. A new module cannot
 * appear unclassified, and raw filesystem access cannot spread to a module that has not
 * declared it.
 *
 * WHAT THESE CANNOT PROVE: that no second settlement classifier exists, and that no
 * operation bypasses the driver. Both are semantic properties; a hand-rolled classifier
 * that imports nothing forbidden passes every check here. Those remain behavioural and
 * review obligations, and a green run of this file is not evidence about them. Reading
 * it as such would repeat the doc-versus-code failure this program has already hit.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  importedSpecifiers, importsNodeFilesystem, referencesSymbol, withoutComments,
} from "./source-text.js";
import { describe, expect, it } from "vitest";
import {
  CURRENT_FILESYSTEM_OWNERS, EXPECTED_MODULE_ROLES, LIFECYCLE_MODULE_OWNERSHIP,
} from "./module-ownership.js";
import { listFilesUnder } from "./walk.js";
import type { LifecyclePlanKind } from "../../../src/preparations/lifecycle-driver.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const PREPARATIONS = "src/preparations";

/**
 * Every module the lifecycle model owns, DERIVED rather than restated.
 *
 * This was the directory literal `src/preparations`, and that boundary is why two
 * defects went unseen: a duplicated staged-delete derivation and a swallowed
 * recursive `rm`, both living in `src/utils` modules that lifecycle code reaches
 * every day. The ownership model classified neither, because neither was under
 * the directory someone had typed.
 *
 * The scope is the preparations tree plus the TRANSITIVE closure of the
 * `src/utils` modules it reaches. A new shared primitive must be classified
 * before it can be used, which the literal could never provide.
 *
 * TRANSITIVE, not one hop. A first version followed imports from
 * `src/preparations` and stopped, which missed three utilities reached only
 * utility-to-utility -- and because the control compares that discovery against
 * the hand-maintained table, a truncated walk CERTIFIES ITSELF: both sides shrink
 * together and nothing goes red. A partially derived scope is more dangerous than
 * an honest literal, because it reads as derived.
 */
async function discoveredPreparationModules(): Promise<string[]> {
  const preparations = await listFilesUnder(REPO_ROOT, PREPARATIONS, ".ts");
  const reached = new Set<string>();
  const queue = [...preparations];
  while (queue.length > 0) {
    const module = queue.pop() as string;
    const source = await readFile(path.join(REPO_ROOT, module), "utf8");
    for (const raw of importedSpecifiers(module, source)) {
      if (!raw.startsWith(".")) continue;
      const specifier = raw.replace(/\.js$/u, ".ts");
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(module), specifier));
      // Follow only into src/utils, and only once per module.
      if (!resolved.startsWith("src/utils/") || reached.has(resolved)) continue;
      reached.add(resolved);
      queue.push(resolved);
    }
  }
  return [...preparations, ...reached].sort();
}

/**
 * Every source module, not just the lifecycle ones.
 *
 * The two controls that police WHO may reach the custody protocol and WHO may
 * mint a permit have to look everywhere, because a module that reaches them is
 * a driver wherever it happens to live. Scoping them to `src/preparations` made
 * a compiling bypass invisible: a file at `src/lifecycle-sneak.ts` that minted a
 * permit and drove the protocol itself left all twelve controls green.
 *
 * The other controls here stay scoped, deliberately — their allowlists are lists
 * of lifecycle modules, and widening those would flag every unrelated module in
 * the repository that touches the filesystem.
 */
async function discoveredSourceModules(): Promise<string[]> {
  return (await listFilesUnder(REPO_ROOT, "src", ".ts")).sort();
}

/** Modules importing raw filesystem primitives without declaring that access. */
async function forbiddenFilesystemImports(): Promise<string[]> {
  const declared = new Set(CURRENT_FILESYSTEM_OWNERS);
  const offenders: string[] = [];
  for (const module of await discoveredPreparationModules()) {
    const source = withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"));
    const importsFs = importsNodeFilesystem(module, source);
    if (importsFs && !declared.has(module)) offenders.push(module);
  }
  return offenders;
}

/**
 * Operation adapters that bypass the focused lifecycle filesystem family.
 *
 * This lexical check covers static and parenthesized dynamic utility imports;
 * it is not proof against every JavaScript spelling. Operation adapters
 * currently need no `../utils/` dependency; filesystem mechanics belong
 * behind `./lifecycle-fs/*`.
 */
async function adapterFilesystemBypasses(): Promise<string[]> {
  const adapters = LIFECYCLE_MODULE_OWNERSHIP
    .filter((entry) => entry.role === "operation-adapter")
    .map((entry) => entry.path);
  const bypasses: string[] = [];
  const direct = /(?:from\s+|import\s+|import\s*\()\s*["'](?:node:fs(?:\/promises)?|\.\.\/utils\/[^"']+)["']/u;
  for (const module of adapters) {
    const source = withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"));
    if (direct.test(source)) bypasses.push(module);
  }
  return bypasses;
}

/**
 * Modules other than the driver that IMPORT the two-phase custody protocol.
 *
 * PLA-INV-07: "Operation-specific adapters cannot invent their own
 * plan/apply/verify/complete protocol." Before Task 9D both `quarantine.ts` and
 * `reset.ts` imported `runTwoPhaseQuarantine` and drove the custody phases
 * themselves; the driver now owns that sequence and adapters supply only
 * eligibility and the object set.
 *
 * NARROWER THAN THE INVARIANT, deliberately. This closes the IMPORT route only.
 * An adapter that hand-rolls plan/apply/verify without importing anything is
 * invisible here, exactly as this file's header says. It is one route closed, not
 * the semantic property proved.
 */
/**
 * Every terminal custody engine, keyed BY PLAN KIND.
 *
 * A `Record<LifecyclePlanKind, string>` rather than a list, because a list was
 * self-referential: the previous version compared a hand-written array against a
 * hand-written copy of itself, so a fourth plan kind and engine could be added
 * without touching either and the control that claimed to prevent that would stay
 * green. Review caught it one round after the list was introduced to fix the same
 * shape.
 *
 * Keyed by the union, TypeScript refuses to compile a missing entry. That is the
 * derivation this control lacked: the plan kinds are the enumeration, so the
 * engine set is a function of them rather than a second list to keep in step.
 */
const CUSTODY_ENGINES: Record<LifecyclePlanKind, string> = {
  "custody-move": "runTwoPhaseQuarantine",
  "verified-delete": "runTwoPhaseVerifiedDelete",
  "verified-destroy": "destroySettledQuarantineUnit",
};

async function nonDriverCustodyProtocolImports(): Promise<string[]> {
  const owners = new Set(LIFECYCLE_MODULE_OWNERSHIP
    .filter((entry) => entry.role === "driver")
    .map((entry) => entry.path));
  // The module that DEFINES the protocol is not importing it.
  owners.add("src/preparations/quarantine-move.ts");
  const offenders: string[] = [];
  for (const module of await discoveredSourceModules()) {
    if (owners.has(module)) continue;
    const source = await readFile(path.join(REPO_ROOT, module), "utf8");
    // Any reference, not any braced import. The previous match was
    // `import { … } from "…"` only, so a namespace import and a dynamic import
    // both reached the custody protocol with this control green.
    for (const engine of Object.values(CUSTODY_ENGINES)) {
      if (referencesSymbol(source, engine)) offenders.push(`${module} -> ${engine}`);
    }
  }
  return offenders;
}

/**
 * Modules importing the permit-minting seam that are not declared drivers.
 *
 * Design V2 §9.1 item 5: "the permit minting seam is imported only by declared
 * driver modules." The permit is an accidental-bypass control, so this is the
 * enforcement that keeps it meaningful — anything in-process can call the mint,
 * and what stops that being routine is that importing it is visible and checked.
 */
async function nonDriverPermitMinters(): Promise<string[]> {
  const drivers = new Set(LIFECYCLE_MODULE_OWNERSHIP
    .filter((entry) => entry.role === "driver")
    .map((entry) => entry.path));
  drivers.add("src/preparations/lifecycle-mutation-permit.ts");
  const offenders: string[] = [];
  for (const module of await discoveredSourceModules()) {
    if (drivers.has(module)) continue;
    const source = await readFile(path.join(REPO_ROOT, module), "utf8");
    // Comment-stripped, like its sibling. Reading raw source made this fire on a
    // docblock that merely NAMED the seam — a control that reddens when someone
    // documents the rule is a control that gets deleted.
    if (referencesSymbol(source, "mintLifecycleMutationPermit")) offenders.push(module);
  }
  return offenders;
}

/** Count non-comment lines in one named async function declaration and body. */
function asyncFunctionLines(rawSource: string, name: string): number {
  // Was a third private answer to "what is a comment", in the same file as two
  // others — precisely what source-text.ts exists to prevent. Its line-prefix
  // test also miscounted a trailing `code(); // note` as code plus nothing, and
  // a block comment's interior lines only when they happened to start with `*`.
  const source = withoutComments(rawSource);
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error(`cannot locate async function ${name}`);
  return source.slice(start, end + 2)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .length;
}

/**
 * Lifecycle-role modules that reach the filesystem without being the owner and without
 * owing a migration. Modules outside the lifecycle boundary are excluded deliberately:
 * evidence capture, input staging, and attempt custody legitimately do their own I/O
 * and are not what this design is unifying.
 */
function undeclaredOwnershipRoles(): string[] {
  const lifecycleRoles = new Set([
    "driver", "operation-adapter", "read-consumer", "record-codec", "path-schema", "classifier",
  ]);
  return LIFECYCLE_MODULE_OWNERSHIP
    .filter((entry) => entry.rawFilesystemAccess && lifecycleRoles.has(entry.role))
    // Only a 9B obligation excuses raw filesystem access. A 9D/9E obligation is
    // unrelated debt and must never launder an undeclared filesystem reach.
    .filter((entry) => entry.migrationObligation?.startsWith("9B") !== true)
    .map((entry) => entry.path);
}

/**
 * Every name through which a read consumer could reach a root-taking capture.
 *
 * Greping `*FromRoot(` alone polices the PRIVATE spelling and misses the public
 * one: `quarantine-move.ts` re-exports the wrappers under shorter names, and
 * those are what the rest of the codebase calls. A read consumer using
 * `listQuarantineUnits(root)` captures a second time while its source contains
 * one `withPreparationLifecycleRead(` and zero `FromRoot(` — invisible to both
 * counting legs.
 *
 * SCOPE: the alias NAMES are derived, the MODULE LIST is not. This follows one
 * hop, through the modules named below, and finds wrappers only where they are
 * exported as `async function …FromRoot`. An alias defined elsewhere, exported as
 * a const, or reached through two hops is NOT covered. A new alias in one of
 * these modules is.
 */
async function rootTakingReachNames(): Promise<string[]> {
  const wrappers = new Set<string>();
  const compat = await readFile(
    path.join(REPO_ROOT, "src/preparations/lifecycle-snapshot/compat.ts"), "utf8");
  for (const match of compat.matchAll(/export async function (\w+FromRoot)\b/gu)) {
    wrappers.add(match[1] as string);
  }
  const names = new Set(wrappers);
  // Follow one hop of re-export aliasing, which is how the public names arise.
  // Split on exported-function boundaries and keep any whose BODY names a wrapper.
  for (const module of ["src/preparations/quarantine-move.ts"]) {
    const source = withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"));
    const blocks = source.split(/(?=export (?:async )?function )/u);
    for (const block of blocks) {
      const declared = /^export (?:async )?function (\w+)/u.exec(block)?.[1];
      if (declared === undefined) continue;
      if ([...wrappers].some((wrapper) => block.includes(wrapper))) names.add(declared);
    }
  }
  return [...names];
}

describe("lifecycle structural ownership controls", () => {
  it("classifies every preparation production module", async () => {
    const declared = LIFECYCLE_MODULE_OWNERSHIP.map((entry) => entry.path).sort();
    expect(await discoveredPreparationModules()).toEqual(declared);
  });

  it("keeps raw lifecycle filesystem imports in declared owners", async () => {
    expect(await forbiddenFilesystemImports()).toEqual([]);
  });

  it("has discharged every Task 9B raw-filesystem migration obligation", () => {
    // Scoped to 9B's own obligations: Task 9C records live 9D/9E debt through the
    // same field, and asserting the field is globally empty would force that debt
    // to be deleted rather than discharged.
    const owed = LIFECYCLE_MODULE_OWNERSHIP
      .filter((entry) => entry.migrationObligation?.startsWith("9B") === true);
    expect(owed).toEqual([]);
  });

  it("pins every module's declared role", () => {
    // The capture-count and filesystem controls both SELECT on role, so an
    // unpinned role is a way to leave a control's scope rather than satisfy it:
    // reclassifying references.ts from read-consumer to unrelated-preparation
    // silences the capture control entirely while every test stays green. That is
    // the same self-declared-label escape as the invented obligation, one field
    // over, so it gets the same closure — the exact pairs are asserted.
    const declared = LIFECYCLE_MODULE_OWNERSHIP
      .map((entry) => `${entry.path} :: ${entry.role}`).sort();
    // Assert the WHOLE table, not the read-consumer slice. Roles gate three
    // controls — the capture check, adapterFilesystemBypasses, and the raw-fs
    // prefilter — so pinning one role leaves the others launderable: moving
    // retention.ts out of operation-adapter silences the adapter control with every
    // test green. Asserting the full list closes all of them at once, and it also
    // removes the length check that stood here, which compared a mapped array's
    // length to its source's and therefore could never fail.
    expect(declared).toEqual(EXPECTED_MODULE_ROLES);
  });

  it("holds the obligation set to an exact declared list", () => {
    // Prefix-scoped assertions left the complement unpoliced: an invented
    // obligation under a new prefix passed every control AND satisfied the
    // raw-filesystem exemption, so flipping rawFilesystemAccess self-authorized a
    // node:fs import. The vocabulary is a closed union, so the set can be pinned
    // exactly — and an exact list is what makes an ADDED obligation as visible as
    // a dropped one.
    //
    // SCOPE: this pins the obligations that are recorded. It is not a proof that
    // every module owing 9D/9E work carries a row — several destructive modules
    // do multi-capture work that is deliberately out of Chunk 3's scope.
    const owed = LIFECYCLE_MODULE_OWNERSHIP
      .filter((entry) => entry.migrationObligation !== undefined)
      .map((entry) => `${entry.path} :: ${entry.migrationObligation as string}`)
      .sort();
    expect(owed).toEqual([
      "src/preparations/lifecycle-snapshot/compat.ts :: 9D/9E-root-taking-operation-wrappers",
      // quarantine.ts OWNS the destructive traversal — it defines
      // scanForDestructivePlan and holds the only import of scanPreparationOrphans.
      // retention.ts is one of its three call sites. Recording only the caller sent
      // a 9D/9E worker to a consumer and left the owner unmarked.
      "src/preparations/quarantine.ts :: 9D/9E-destructive-traversal",
      "src/preparations/retention.ts :: 9D/9E-destructive-traversal",
    ]);
  });

  it("routes operation-adapter filesystem work through lifecycle-fs", async () => {
    expect(await adapterFilesystemBypasses()).toEqual([]);
  });

  it("keeps observeRegistry below the repository function-size ceiling", async () => {
    const source = await readFile(
      path.join(REPO_ROOT, "src/preparations/lifecycle-fs/observe.ts"),
      "utf8",
    );
    expect(asyncFunctionLines(source, "observeRegistry")).toBeLessThan(40);
  });

  it("leaves no lifecycle module reaching the filesystem without an owed migration", () => {
    expect(undeclaredOwnershipRoles()).toEqual([]);
  });

  it("catches the known reader-side confirmation shapes, without claiming to close fix-locality", async () => {
    // SCOPE, stated plainly because a control that overstates itself is the exact defect
    // this corpus keeps finding. This is a LEXICAL heuristic, not static analysis. It
    // greps for a parsed record's `.confirmation` being read outside a parser module.
    //
    // It DOES catch the round-18 regression shape and the temp-variable variant that
    // evaded the first version of this check:
    //     if (unit.intent.confirmation !== required)
    //     const recorded = unit.intent.confirmation;
    //
    // It does NOT catch, and must not be cited as proving the absence of: destructuring
    // (`const { confirmation } = unit.intent`), the field reached through a helper or an
    // alias, dynamic access (`unit.intent["confirmation"]`), or the same mistake made on
    // any OTHER field. Fix-locality is a property of where code lives; nothing lexical
    // closes it. The real guarantee is the production design — the reason/confirmation
    // rule lives in `parseResetIntent`, so every reader inherits it — and this test is a
    // regression tripwire on the one shape that has actually bitten, nothing more.
    //
    // What the caller supplied is theirs to check anywhere: that is an authorization
    // question about the caller, not a consistency question about the record.
    const callerSupplied = new Set(["input", "options", "request", "params"]);
    const isParser = (module: string) => /receipts\.ts$|parse/.test(module);
    const offenders: string[] = [];
    for (const module of await discoveredPreparationModules()) {
      if (isParser(module)) continue;
      const source = withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"));
      for (const match of source.matchAll(/([\w.]+)\.confirmation\b/g)) {
        const receiver = (match[1] as string).split(".")[0] as string;
        if (!callerSupplied.has(receiver)) offenders.push(`${module}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps a pendingness-projecting module off the root-taking inventory", async () => {
    // SCOPE, because overstating a control is the class this chunk has already hit
    // twice: this is a COARSE per-module tripwire. The per-decision guarantee —
    // exactly one capture per complete decision — is carried by the opendir counter
    // in lifecycle-single-capture.test.ts, not here. A per-module lexical check
    // cannot express a per-decision property.
    //
    // What it does catch is the shape that actually regressed: reference
    // composition took a root for its inventory (`scanPreparationInventory`, which
    // captures internally) AND separately projected lifecycle pendingness, giving
    // two captures per answer. Verified against the real pre-Chunk-3 module: it
    // scores zero on capture-counting and zero on wrapper reaches, so those checks
    // alone would have passed it. A module that projects pendingness must take its
    // inventory from the SUPPLIED variant.
    //
    // recovery.ts is untouched by this: it uses the root-taking inventory for
    // handoff settlement and `projectLifecyclePending` for a different decision,
    // and never combines the two.
    const definesWrappers = "src/preparations/lifecycle-snapshot/compat.ts";
    const readConsumers = LIFECYCLE_MODULE_OWNERSHIP
      .filter((entry) => entry.role === "read-consumer" && entry.path !== definesWrappers)
      .map((entry) => entry.path);
    const offenders: string[] = [];
    const reaches = await rootTakingReachNames();
    for (const module of readConsumers) {
      // Comment-stripped. Reading raw source made a docblock saying DO NOT call
      // the root-taking variant count as calling it, so documenting the rule
      // turned this control red.
      const source = withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"));
      const captures = source.match(/withPreparationLifecycleRead\s*\(/gu)?.length ?? 0;
      if (captures > 1) offenders.push(`${module}: ${captures} in-module captures`);
      for (const reach of reaches) {
        if (new RegExp(`\\b${reach}\\s*\\(`, "u").test(source)) {
          offenders.push(`${module}: reaches root-taking ${reach}`);
        }
      }
      const projectsPending = /\bsnapshotHasPendingLifecycle\s*\(/u.test(source);
      const rootTakingInventory = /\bscanPreparationInventory\s*\(/u.test(source);
      if (projectsPending && rootTakingInventory) {
        offenders.push(`${module}: projects pendingness beside a root-taking inventory`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it("derives the staged-delete name in exactly ONE place", async () => {
    // §14.5 clause 4: delete superseded staged-delete implementations. It was
    // derived TWICE from one formula -- privately by the delete executor and
    // publicly by the postcondition classifier -- so the code that STAGED a file
    // and the code that CLASSIFIES it computed the same name independently. One
    // drift and the classifier inspects a different file than the executor wrote.
    //
    // Asserted on the CONSTANT's use rather than on the formula text: a second
    // implementation would have to reach for the same prefix, and a copy that
    // inlined the prefix instead is caught by the padStart sweep below.
    const users: string[] = [];
    for (const module of await discoveredSourceModules()) {
      const source = withoutComments(await readFile(path.join(REPO_ROOT, module), "utf8"));
      if (referencesSymbol(source, "STAGED_DELETE_PREFIX")) users.push(module);
    }
    // paths.ts alone: it declares the prefix AND derives the name, in the layer
    // below both consumers. A first attempt put the derivation in the snapshot
    // layer and pointed the filesystem layer at it, inverting the dependency --
    // caught by the architecture control, not by this one.
    expect(users.sort()).toEqual(["src/preparations/paths.ts"]);
  });

  it("keeps the custody protocol behind the driver", async () => {
    // The import half of PLA-INV-07. Task 9D introduced the first `driver` module;
    // before it, two operation adapters imported the two-phase entry point and ran
    // the protocol themselves.
    expect(await nonDriverCustodyProtocolImports()).toEqual([]);
  });
  it("mints custody permits only from a declared driver", async () => {
    expect(await nonDriverPermitMinters()).toEqual([]);
  });
});
