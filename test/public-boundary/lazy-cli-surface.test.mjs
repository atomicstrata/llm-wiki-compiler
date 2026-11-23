/**
 * @file test/public-boundary/lazy-cli-surface.test.mjs
 * @description Witnesses that the surface gate reads the CLI's top-level
 * commands from the table the entry passes to
 * `declareLazyCommands(program, COMMANDS)`, keeps reading legacy
 * `program.command("…")` calls, and REFUSES a live table it cannot read
 * instead of reporting no commands.
 *
 * Two fixtures are exact byte copies of real entry files: the public
 * `src/cli.ts` at commit 3811599e (31 commands) and the integrated
 * `src/cli.ts` (35: the public 31 plus catalog, init, project and scale).
 * Each fixture's SHA-256 is checked before it is read, so an edited copy fails
 * instead of passing. The expected names are written out here, not derived
 * from the reader. They are checked through `checkSurface` too, which must
 * report a dropped baseline command and an added excluded one. The other cases
 * are small scratch modules: an aliased import, unused tables, subcommand
 * tables and mere mentions, and every unsupported live form. Nothing here
 * imports or runs the CLI. Plain JavaScript on purpose: it imports the gate's
 * `.mjs` modules directly.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { checkSurface, programCommandsOf } from "../../scripts/public-boundary/surface.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lazy-cli");

/** The pinned entry-file copies: fixture file and SHA-256 of the copied bytes. */
const PUBLIC_CLI = { file: "public-3811599e-cli.ts.fixture", sha256: "6f03a5b7cd121857e6efe0a9ef90e42bbd231480e7b456742f61026de044346c" };
const CURRENT_CLI = { file: "current-4136f99a-cli.ts.fixture", sha256: "4136f99a34a50dd06ea45bd649680b807ab6ccdc6ff5ac22a323ba0aa651b0a3" };

/** The public CLI's 31 top-level commands at 3811599e, sorted. */
const PUBLIC_COMMANDS = ["artifact", "compile", "connector", "context", "eval", "export", "import", "ingest", "ingest-session", "lint", "next",
  "operation", "preparation", "product", "profile", "query", "quickstart", "recover", "refresh", "review", "rm", "rules", "schema", "serve",
  "state", "status", "template", "view", "visualize", "watch", "workflow"];

/** The integrated CLI's 35 top-level commands, sorted, written out independently of the public list. */
const CURRENT_COMMANDS = ["artifact", "catalog", "compile", "connector", "context", "eval", "export", "import", "ingest", "ingest-session",
  "init", "lint", "next", "operation", "preparation", "product", "profile", "project", "query", "quickstart", "recover", "refresh", "review",
  "rm", "rules", "scale", "schema", "serve", "state", "status", "template", "view", "visualize", "watch", "workflow"];

/** The commands the integrated CLI adds; the manifest allocates exactly these as scaling additions. */
const SCALING_ADDITIONS = ["catalog", "init", "project", "scale"];

/** The entry's named import of the declarer, as the real CLI writes it. */
const IMPORT = 'import { declareLazyCommands, type LazyCommand } from "./cli/lazy-commands.js";\n';
const LOAD = '() => import("./cli/x.js").then((m) => m.register)';

/** One well-formed table entry for `usage`. */
const row = (usage) => `  [${JSON.stringify(usage)}, "description", ${LOAD}]`;

/**
 * A scratch entry module: `rows` as the COMMANDS table, then the declarer call.
 * `importLine`, `keyword` and `call` replace those parts; `before` follows the
 * import and `after` precedes the call.
 */
function entry(rows, { importLine = IMPORT, keyword = "const", before = "", after = "", call = "declareLazyCommands(program, COMMANDS)" } = {}) {
  return `${importLine}${before}${keyword} COMMANDS: LazyCommand[] = [\n${rows.join(",\n")}\n];\nconst program = new Command();\n${after}${call};\n`;
}

/** Sorted, unique command names of a module read at `fileName`. */
const commandsOf = (text, fileName = "src/cli.ts") => [...new Set(programCommandsOf(text, fileName))].sort();

/** The text of a pinned fixture, after checking its bytes against the pin. */
function pinned({ file, sha256 }) {
  const bytes = readFileSync(path.join(FIXTURES, file));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
  return bytes.toString("utf8");
}

/** A boundary surface with one own-source core facade, the real CLI allocations and no MCP source. */
const SURFACE = {
  facades: { core: { internal: "src/core-index.ts", public: "src/core-index.ts" } },
  nameAllocations: {},
  moduleAllocations: [],
  cli: { sources: ["src/cli.ts", "src/cli/"], scalingAdditions: SCALING_ADDITIONS, excluded: { attest: "internal-product-excluded" } },
  mcp: { sources: ["src/mcp/"], scalingAdditionPrefixes: [], excluded: {} },
};

/** The scratch source tree of the current case. */
let root;

/** Give each case of a suite its own scratch tree, removed afterwards. */
function useScratchTree() {
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "lazy-cli-surface-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
}

/** `checkSurface` over a scratch tree whose entry is `cliText`, against a baseline of `baselineCommands`. */
function surfaceOf(cliText, baselineCommands, cli = SURFACE.cli) {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "cli.ts"), cliText);
  writeFileSync(path.join(root, "src", "core-index.ts"), 'export { core } from "./core.js";\n');
  const baseline = { exports: { core: ["core"] }, cliCommands: baselineCommands, mcpTools: [] };
  return checkSurface(root, { surface: { ...SURFACE, cli } }, baseline, ["src/cli.ts"], new Map());
}

describe("the real lazy CLI tables (pinned copies)", () => {
  it("reads the public 3811599e table: 31 commands, rules included, none twice", () => {
    const text = pinned(PUBLIC_CLI);
    expect(programCommandsOf(text, "src/cli.ts")).toHaveLength(31);
    expect(commandsOf(text)).toEqual(PUBLIC_COMMANDS);
    expect(PUBLIC_COMMANDS).toHaveLength(31);
    expect(PUBLIC_COMMANDS).toContain("rules");
  });

  it("reads the integrated table: 35 commands, exactly the public 31 plus catalog, init, project and scale", () => {
    const text = pinned(CURRENT_CLI);
    expect(programCommandsOf(text, "src/cli.ts")).toHaveLength(35);
    expect(commandsOf(text)).toEqual(CURRENT_COMMANDS);
    expect(CURRENT_COMMANDS.filter((name) => !PUBLIC_COMMANDS.includes(name))).toEqual(SCALING_ADDITIONS);
    expect(PUBLIC_COMMANDS.filter((name) => !CURRENT_COMMANDS.includes(name))).toEqual([]);
  });
});

describe("checkSurface over the lazy tables", () => {
  useScratchTree();

  it("passes the public CLI against its own 31-command baseline", () => {
    const result = surfaceOf(pinned(PUBLIC_CLI), PUBLIC_COMMANDS);
    expect(result.violations).toEqual([]);
    expect(result.missingBaseline.cli).toEqual([]);
    expect(result.registered.cliCommands).toEqual(PUBLIC_COMMANDS);
  });

  it("passes the integrated CLI against the public baseline only through the four allocated additions", () => {
    const allocated = surfaceOf(pinned(CURRENT_CLI), PUBLIC_COMMANDS);
    expect(allocated.violations).toEqual([]);
    expect(allocated.registered.cliCommands).toEqual(CURRENT_COMMANDS);
    const unallocated = surfaceOf(pinned(CURRENT_CLI), PUBLIC_COMMANDS, { ...SURFACE.cli, scalingAdditions: [] });
    expect(unallocated.violations).toEqual(SCALING_ADDITIONS.map((name) => ({ kind: "cli", name, allocation: "unallocated" })));
  });

  it("reports a baseline command the table no longer declares", () => {
    const result = surfaceOf(entry([row("compile [options]")]), ["compile", "rules"]);
    expect(result.missingBaseline.cli).toEqual(["rules"]);
    expect(result.violations).toEqual([]);
  });

  it("reports an added excluded command with its exclusion", () => {
    const result = surfaceOf(entry([row("compile [options]"), row("attest <claim>")]), ["compile"]);
    expect(result.violations).toEqual([{ kind: "cli", name: "attest", allocation: "internal-product-excluded" }]);
    expect(result.missingBaseline.cli).toEqual([]);
  });
});

describe("which registrations are top-level commands", () => {
  it("keeps reading legacy program.command calls, alone and next to a lazy table", () => {
    expect(commandsOf('program\n  .command("alpha <x>");\nother.command("not-top-level");', "module.ts")).toEqual(["alpha"]);
    expect(commandsOf(entry([row("compile")], { after: 'program.command("legacy <x>");\n' }))).toEqual(["compile", "legacy"]);
  });

  it("ignores an unused table, a subcommand group's table, and text that only mentions the declarer", () => {
    const before = `const UNUSED: LazyCommand[] = [["ghost", "d", ${LOAD}]];\nconst SUB: LazyCommand[] = [["child", "d", ${LOAD}]];\n`
      + 'const group = new Command();\n// declareLazyCommands(program, UNUSED)\nconst note = "declareLazyCommands(program, UNUSED)";\n';
    expect(commandsOf(entry([row("compile")], { before, after: "declareLazyCommands(group, SUB);\n" }))).toEqual(["compile"]);
  });

  it("follows an aliased named import of the declarer", () => {
    const importLine = 'import { declareLazyCommands as declare, type LazyCommand } from "./cli/lazy-commands.js";\n';
    expect(commandsOf(entry([row("view [options]")], { importLine, call: "declare(program, COMMANDS)" }))).toEqual(["view"]);
  });

  it("binds the import by the module it resolves to from the reading file", () => {
    const sibling = entry([row("view")], { importLine: 'import { declareLazyCommands, type LazyCommand } from "./lazy-commands.js";\n' });
    expect(commandsOf(sibling, "src/cli/extra.ts")).toEqual(["view"]);
    expect(() => programCommandsOf(sibling, "src/other/extra.ts")).toThrow(/not its named import/);
  });
});

/** Live tables in a form the reader does not support, and the refusal each must raise. */
const REFUSED_TABLES = [
  ["a non-literal usage", entry([`  [USAGE, "d", ${LOAD}]`], { before: 'const USAGE = "late";\n' }), /usage is not a string literal/],
  ["a usage with a substitution", entry(['  [`${USAGE} [options]`, "d", ' + LOAD + "]"]), /usage is not a string literal/],
  ["a spread of another table", entry(["  ...BASE", row("compile")]), /not a \[usage, description, load\] array literal/],
  ["an entry with two fields", entry(['  ["compile", "d"]']), /not a \[usage, description, load\] array literal/],
  ["a usage that does not begin with a command name", entry([row("Compile [options]")]), /does not begin with a command name/],
  ["a computed table", `${IMPORT}const COMMANDS: LazyCommand[] = buildTable();\nconst program = new Command();\ndeclareLazyCommands(program, COMMANDS);\n`, /non-empty array literal/],
  ["an empty table", entry([]), /non-empty array literal/],
  ["a let table", entry([row("compile")], { keyword: "let" }), /unexported const/],
  ["an exported table", entry([row("compile")], { keyword: "export const" }), /unexported const/],
  ["a table extended after its declaration", entry([row("compile")], { after: `COMMANDS.push(["late", "d", ${LOAD}]);\n` }), /referenced other than/],
  ["an imported table", `${IMPORT}import { COMMANDS } from "./cli/table.js";\nconst program = new Command();\ndeclareLazyCommands(program, COMMANDS);\n`, /not declared exactly once/],
  ["an inline table", entry([row("compile")], { call: `declareLazyCommands(program, [${row("other")}])` }), /not one identifier/],
  ["a computed group", entry([row("compile")], { call: "declareLazyCommands(groups[0], COMMANDS)" }), /group argument .* is not an identifier/],
];

/** Declarer bindings the reader cannot tell apart from the real one, and the refusal each must raise. */
const REFUSED_BINDINGS = [
  ["a same-named declarer from another module", entry([row("compile")], { importLine: 'import { declareLazyCommands, type LazyCommand } from "./cli/other.js";\n' }), /not its named import/],
  ["a local function of the same name", entry([row("compile")], { importLine: "function declareLazyCommands(group, table) {}\n" }), /not its named import/],
  ["a namespace import of the lazy-commands module", entry([row("compile")], { importLine: 'import * as lazy from "./cli/lazy-commands.js";\n', call: "lazy.declareLazyCommands(program, COMMANDS)" }), /default or namespace import/],
  ["the declarer stored under another name", entry([row("compile")], { before: "const declare = declareLazyCommands;\n" }), /used other than as a direct call/],
];

describe("a live table the reader cannot read is refused, never read as no commands", () => {
  it.each(REFUSED_TABLES)("refuses %s", (_form, text, reason) => {
    expect(() => programCommandsOf(text, "src/cli.ts")).toThrow(reason);
  });

  it.each(REFUSED_BINDINGS)("refuses %s", (_binding, text, reason) => {
    expect(() => programCommandsOf(text, "src/cli.ts")).toThrow(reason);
  });
});

describe("checkSurface fails closed on an unreadable live table", () => {
  useScratchTree();

  it("throws instead of reporting every baseline command as dropped", () => {
    expect(() => surfaceOf(entry([]), ["compile"])).toThrow(/non-empty array literal/);
  });
});
