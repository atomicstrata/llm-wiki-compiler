/**
 * @file test/preparations/lifecycle-model/reach.ts
 * @description Which production functions one test scenario actually calls.
 *
 * Both the coverage matrix and the frozen corpus make claims of the form "this scenario
 * exercises that production entry point", and both are only as good as this resolution.
 * Three review rounds were spent on hand-rolled lexical versions of it, each wrong in a
 * new way: file-granularity credited every scenario in a file with every entry point any
 * scenario there touched, and name-keyed helper lookup collapsed the `const root` that
 * every `describe` block declares, dragging unrelated drivers into a scenario's apparent
 * reach and certifying wrong operation labels.
 *
 * So this uses the TypeScript parser that is already a dependency rather than a fourth
 * regex. Scope matters here and regexes cannot express scope: a helper resolves only if
 * it is declared in a lexical scope that actually encloses the scenario, innermost
 * first, which is precisely what makes two same-named `root` bindings distinct.
 */

import ts from "typescript";

/** One scenario and the production functions its body and in-scope helpers call. */
interface ScenarioReachV1 {
  title: string;
  calls: ReadonlySet<string>;
}

/** Whether a node introduces a lexical scope helpers may be declared in. */
function isScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)
    || ts.isCaseBlock(node) || ts.isForStatement(node) || ts.isForOfStatement(node);
}

/** Names a single statement declares, paired with the statement itself. */
function declaredNames(statement: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(statement)) return statement.name ? [statement.name.text] : [];
  if (!ts.isVariableStatement(statement)) return [];
  return statement.declarationList.declarations
    .map((declaration) => (ts.isIdentifier(declaration.name) ? declaration.name.text : null))
    .filter((name): name is string => name !== null);
}

/**
 * Resolve `name` to its declaration by walking OUTWARD from `node`, innermost scope
 * first. Returning the nearest enclosing binding is the whole point: a name-keyed map
 * cannot distinguish the `root` of one `describe` from the `root` of another, and that
 * conflation is what let unrelated helpers leak into a scenario's reach.
 */
function resolveInScope(node: ts.Node, name: string): ts.Node | null {
  for (let scope: ts.Node | undefined = node; scope !== undefined; scope = scope.parent) {
    if (!isScope(scope)) continue;
    const statements = ts.isSourceFile(scope) ? scope.statements
      : (scope as ts.Block).statements ?? ts.factory.createNodeArray();
    for (const statement of statements) {
      if (declaredNames(statement).includes(name)) return statement;
    }
  }
  return null;
}

/** Every identifier invoked as a bare function call anywhere under `node`. */
function calledNames(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      names.push(current.expression.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

/**
 * Every function a scenario reaches: the ones it calls directly, plus — transitively —
 * the ones called by helpers it names, where a helper counts only if it is declared in
 * an enclosing lexical scope. Anything unresolved is an import, which is exactly what a
 * production entry point is, so it stays in the set.
 */
function reachOf(scenario: ts.Node): Set<string> {
  const reached = new Set<string>();
  const pending = calledNames(scenario).map((name) => ({ name, from: scenario }));
  const expanded = new Set<string>();
  while (pending.length > 0) {
    const { name, from } = pending.pop() as { name: string; from: ts.Node };
    reached.add(name);
    if (expanded.has(name)) continue;
    expanded.add(name);
    const declaration = resolveInScope(from, name);
    if (declaration === null) continue; // imported: a leaf, and possibly the entry point
    for (const inner of calledNames(declaration)) pending.push({ name: inner, from: declaration });
  }
  return reached;
}

/** The base callee name of a call, seeing through `it.only` / `it.each` style access. */
function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return callee.expression.text;
  return null;
}

/** Whether a call is an `it(...)` / `it.only(...)` scenario with a title and a body. */
function scenarioTitle(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const name = calleeName(node.expression);
  if (name !== "it" && name !== "test") return null;
  const [title, body] = node.arguments;
  if (title === undefined || body === undefined || !ts.isStringLiteralLike(title)) return null;
  return ts.isFunctionExpression(body) || ts.isArrowFunction(body) ? title.text : null;
}

/** Every scenario in one test source, with the production calls it actually reaches. */
export function scenarioReach(fileName: string, source: string): ScenarioReachV1[] {
  const found: ScenarioReachV1[] = [];
  forEachScenario(fileName, source, (title, node) => found.push({ title, calls: reachOf(node) }));
  return found;
}

/**
 * Every scenario's title and normalised body text. Parsed rather than pattern-matched
 * because the regex this replaces terminated a title at its first quote character, so
 * every title containing an apostrophe was silently truncated in the frozen manifest —
 * and the manifest's own checker used the same regex, which is why it stayed green.
 * Normalising whitespace keeps reformatting from reading as a behavioural change.
 */
export function scenarioBodies(fileName: string, source: string): { title: string; body: string }[] {
  const found: { title: string; body: string }[] = [];
  forEachScenario(fileName, source, (title, node) =>
    found.push({ title, body: node.getText().replace(/\s+/g, " ").trim() }));
  return found;
}

/** Visit every `it(...)` / `test(...)` scenario call in one source. */
function forEachScenario(
  fileName: string, source: string, onScenario: (title: string, node: ts.Node) => void,
): void {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const visit = (node: ts.Node): void => {
    const title = scenarioTitle(node);
    if (title !== null) onScenario(title, node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}
