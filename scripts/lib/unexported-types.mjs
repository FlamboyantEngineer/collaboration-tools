// Finds the library types a public type names for a member, parameter or signature that no package
// entry point exports, so a host could not name the type of a value it passes (coding guideline N4).

import { relative, sep } from 'node:path';
import ts from 'typescript';

const NAMED_TYPE = ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Enum;

/**
 * @param {ts.TypeChecker} checker
 * @param {ts.Symbol} symbol
 */
function resolveAlias(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Nodes whose type is what a caller passes or receives: members, parameters and signatures. */
const memberPosition = [
  ts.isPropertySignature,
  ts.isMethodSignature,
  ts.isParameter,
  ts.isCallSignatureDeclaration,
  ts.isConstructSignatureDeclaration,
  ts.isIndexSignatureDeclaration,
  ts.isFunctionTypeNode,
];

/**
 * Calls `visit` with each type a declaration names, and whether it names it in a member position.
 * A type named elsewhere only shapes the declaration: a base interface, or a type the alias joins.
 * An alias that instantiates a generic type (`Loader = RemoteLoader<Item>`) is itself the name a
 * host uses, so the generic is not visited.
 * @param {ts.Node} node
 * @param {(reference: ts.EntityName | ts.Expression, isMember: boolean) => void} visit
 * @param {boolean} [isMember]
 */
function forEachReference(node, visit, isMember = false) {
  if (ts.isTypeReferenceNode(node) && (isMember || !node.typeArguments))
    visit(node.typeName, isMember);
  if (ts.isExpressionWithTypeArguments(node)) visit(node.expression, isMember);
  const childIsMember = isMember || memberPosition.some((test) => test(node));
  ts.forEachChild(node, (child) => forEachReference(child, visit, childIsMember));
}

/**
 * Lists, for each exported type declared under `dir`, the library types it names that are not
 * exported from any entry point, as `<file>: <Exported> names unexported <Name>`.
 * @param {string} dir the declaration directory (normally `dist/`)
 * @param {{ entries: string[], only?: string[] }} options `entries` are the declaration files a
 *   host imports; `only` limits the report to types declared in these components.
 * @returns {string[]}
 */
export function findUnexportedTypes(dir, { entries, only = [] }) {
  const roots = entries;
  const program = ts.createProgram(roots, { noEmit: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const inDir = (/** @type {ts.Declaration} */ declaration) =>
    !relative(dir, declaration.getSourceFile().fileName).startsWith('..');

  const exported = new Set();
  for (const path of roots) {
    const source = program.getSourceFile(path);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) continue;
    for (const symbol of checker.getExportsOfModule(module))
      exported.add(resolveAlias(checker, symbol));
  }

  const problems = new Set();
  /**
   * Reports the unexported types `declaration` names as members of `owner`, and checks the
   * unexported types that shape it (its bases, its alias target) as part of `owner` too.
   * @param {ts.Declaration} declaration
   * @param {string} owner
   * @param {Set<ts.Symbol>} seen
   */
  const check = (declaration, owner, seen) => {
    forEachReference(declaration, (name, isMember) => {
      const found = checker.getSymbolAtLocation(name);
      const target = found && resolveAlias(checker, found);
      if (!target || !(target.flags & NAMED_TYPE) || exported.has(target)) return;
      const declarations = (target.declarations ?? []).filter(inDir);
      if (declarations.length === 0) return;
      if (isMember) problems.add(`${owner} names unexported ${target.name}`);
      else if (!seen.has(target)) {
        seen.add(target);
        for (const shape of declarations) check(shape, owner, seen);
      }
    });
  };
  for (const symbol of exported) {
    if (!(symbol.flags & NAMED_TYPE)) continue;
    for (const declaration of symbol.declarations ?? []) {
      if (!inDir(declaration)) continue;
      const file = relative(dir, declaration.getSourceFile().fileName).split(sep).join('/');
      if (only.length > 0 && !only.some((name) => file.startsWith(`components/${name}/`))) continue;
      check(declaration, `${file}: ${symbol.name}`, new Set([symbol]));
    }
  }
  return [...problems].sort();
}
