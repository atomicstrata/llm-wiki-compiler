/** Parse literal module edges for package and passive-history boundary checks. */
import { readFileSync } from "node:fs";
import ts from "typescript";

/** Recognize syntax that names a module, including dynamic and type imports. */
function moduleSpecifier(node: ts.Node, source: ts.SourceFile): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (!ts.isCallExpression(node)) return undefined;
  const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  return dynamic || node.expression.getText(source) === "require" ? node.arguments[0] : undefined;
}

/** Return literal import paths without resolving package or source identities. */
export function literalModuleImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    const specifier = moduleSpecifier(node, source);
    if (specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}
