// THE identity layer: every entity id in the fact base and in the runtime
// trace, and the entity names the history oracle joins on, come from this
// module. ADR-0001 states the rule — one function produces entity ids, and
// both declaration emission and edge resolution route through it, so closure
// holds by construction. Before f1c1455 the two sides built ids separately and
// 135 call edges dangled on a string-format disagreement. The rule then held
// inside extract.ts while ids.ts and history.ts kept hand-copies of it:
// ids.ts's copy was still in sync when it was deleted, history.ts's had
// drifted — its isDefaultExport called `SyntaxKind.DefaultKeyword` without
// importing SyntaxKind and swallowed the ReferenceError in its own catch, so
// no `export default` was ever named `default` there.
// Callers must setRoot() before computing any id: the `ts:` namespace is
// relative to the analysed source root.
import { Node, SyntaxKind } from "ts-morph";
import * as path from "path";

let ROOT = "";
export const setRoot = (r: string) => { ROOT = r; };

function mid(file: string) { return `module:${slug(path.relative(ROOT, file))}`; }

// A path outside the analysed source root belongs to a dependency, not to this
// repository. Building a `ts:` id from it produced strings like
// `ts:../../../../../../node_modules/typescript/lib/lib.es5.d.ts:isArray` —
// a path-escape artifact, not an identifier.
function isExternalPath(fp: string) {
  if (fp.includes("/node_modules/")) return true;
  const r = path.relative(ROOT, fp);
  return r.startsWith("..") || path.isAbsolute(r);
}

// Which dependency a path belongs to, for the external id namespace.
function externalOrigin(fp: string): string {
  const i = fp.lastIndexOf("/node_modules/");
  if (i >= 0) {
    const seg = fp.slice(i + "/node_modules/".length).split("/");
    return seg[0].startsWith("@") && seg[1] ? `${seg[0]}/${seg[1]}` : seg[0];
  }
  if (/\/lib\.[a-z0-9.]*d\.ts$/.test(fp)) return "typescript-lib";
  return "unknown";
}

function eid(file: string, name: string) {
  return isExternalPath(file)
    ? `external:${slug(externalOrigin(file))}:${name}`
    : `ts:${slug(path.relative(ROOT, file))}:${name}`;
}

// An anonymous function that is not bound to a name — a callback passed
// straight into a call, as in `$constructor("ZodString", (inst, def) => {...})`.
// Its parameters and locals need some disambiguator or they collide with every
// other callback's `inst` in the same file.
//
// The segment is the node's kind, its syntactic slot, and an index among
// same-kind, same-slot nodes under the nearest NAMED ancestor, in document
// order. Indexing within the immediate parent gave every sibling in a promise
// chain the same segment: `.then(() => {...}).then((x) => {...})` has two
// arrows with different parents, each index 0 in its own parent. Indexing
// among ALL same-kind nodes under the anchor then made the index shift whenever
// any earlier sibling was inserted — 6f04836 removed one callback per check and
// renumbered every `inst._zod.check = (payload) => ...` after it.
// shortcut: still positional within a slot, so an earlier rival in the SAME
// slot (a second `.push(() => ...)`, another `if`) shifts it; revisit if the
// history harness's ro_positional count says that drift matters.
function anonSegment(node: any): string {
  const kindTag = `@${node.getKindName().replace(/Expression$|Declaration$/, "").toLowerCase()}`;
  const slot = anonSlot(node);
  const tag = slot ? `${kindTag}[${slot}]` : kindTag;
  let anchor: any = null;
  for (let a = node.getParent?.(); a; a = a.getParent?.()) {
    if (Node.isSourceFile(a)) { anchor = a; break; }
    if (namedSegment(a)) { anchor = a; break; }
  }
  if (!anchor) return `${tag}0`;
  // Overload signatures are separate nodes carrying one name, so indexing
  // under a single one restarts at 0 in each: every `_function(params: {...})`
  // overload yielded `_function.@typeliteral0`. Index across all same-kind
  // declarations of the anchor's symbol in this file instead.
  const file = anchor.getSourceFile();
  const own = Node.isSourceFile(anchor) ? [] : (anchor.getSymbol?.()?.getDeclarations() ?? [])
    .filter((d: any) => d.getKind() === anchor.getKind() && d.getSourceFile() === file);
  const anchors = own.includes(anchor) ? own.sort((a: any, b: any) => a.getStart() - b.getStart()) : [anchor];
  const sibs = anchors.flatMap((a: any) => a.getDescendantsOfKind?.(node.getKind()) ?? []).filter((c: any) => anonSlot(c) === slot);
  const i = sibs.findIndex((c: any) => c === node);
  return `${tag}${i < 0 ? 0 : i}`;
}

// The slot an anonymous node fills: the property or variable it is assigned to
// (`inst._zod.check = ...` -> check), the function it is an argument of
// (`$constructor(...)` -> $constructor), `return`, or for a nested block the
// statement that owns it (if / else / for / try / finally ...). "" if none.
function anonSlot(node: any): string {
  const p = node.getParent?.();
  if (!p) return "";
  const nameOf = (e: any) => Node.isPropertyAccessExpression(e) ? e.getName() : Node.isIdentifier(e) ? e.getText() : "";
  let s = "";
  if (Node.isBinaryExpression(p) && p.getOperatorToken().getKind() === SyntaxKind.EqualsToken && p.getRight() === node) s = nameOf(p.getLeft());
  else if ((Node.isCallExpression(p) || Node.isNewExpression(p)) && (p.getArguments() ?? []).includes(node)) s = nameOf(p.getExpression());
  else if (Node.isReturnStatement(p)) s = "return";
  else if (Node.isBlock(node)) {
    s = Node.isIfStatement(p) ? (p.getElseStatement() === node ? "else" : "if")
      : Node.isTryStatement(p) ? (p.getFinallyBlock() === node ? "finally" : "try")
      : p.getKindName().replace(/Statement$/, "").toLowerCase();
  }
  return s.replace(/[^\w$]/g, "_");
}

// One segment of the lexical scope path, for ancestors that introduce a scope.
// Previously only classes and interfaces were consulted, via an `ownerName`
// that walked to the NEAREST class or interface. That produced three defects:
// members of object literals got a bare name, members of nested type literals
// got the enclosing interface's name (so `interface Foo { x: { y: T } }` yielded
// `Foo.y`, colliding with a real `Foo.y`), and parameters, bindings and locals
// were never qualified at all. 438 ids collided within value space as a result.
// The named half of scopeSegment, factored out so anonSegment can find its
// anchor without recursing back through the anonymous branch.
function namedSegment(a: any): string | null {
  if (Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isClassExpression(a)
      || Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) || Node.isMethodSignature(a)
      || Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a)
      || Node.isTypeAliasDeclaration(a) || Node.isEnumDeclaration(a)
      || Node.isVariableDeclaration(a) || Node.isPropertyAssignment(a)
      || Node.isPropertyDeclaration(a) || Node.isPropertySignature(a)
      || Node.isModuleDeclaration(a)) {
    return a.getName?.() || null;
  }
  if (Node.isConstructorDeclaration(a)) return "constructor";
  return null;
}

// A nested block (`if`, `for`, `try`) is a real lexical scope: a parameter and
// a `const` of the same name can coexist when the const is inside one. A
// function BODY block is not segmented, because the function already is.
const isNestedBlock = (a: any) => {
  if (!Node.isBlock(a)) return false;
  const p = a.getParent?.();
  return !!p && !isCallableContainer(p) && !Node.isConstructorDeclaration(p);
};

function scopeSegment(a: any): string | null {
  const named = namedSegment(a);
  if (named) return named;
  // A bound construct contributes nothing of its own: its binding is the
  // VariableDeclaration or PropertyAssignment above, already a segment.
  const bound = (n: any) => {
    const p = n.getParent?.();
    return !!p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p)
      || Node.isPropertyDeclaration(p) || Node.isPropertySignature(p)
      || Node.isTypeAliasDeclaration(p));
  };
  if (Node.isArrowFunction(a) || Node.isFunctionExpression(a)) {
    return bound(a) ? null : anonSegment(a);
  }
  // An unbound type or object literal — a return-type annotation such as
  // `_getCached(): { shape: T; keys: string[] }`, or a literal in a return
  // statement. Without a segment its members share the enclosing named scope
  // with that scope's own locals, so `{ shape: T }` collided with `const shape`.
  if (Node.isTypeLiteral(a) || Node.isObjectLiteralExpression(a)) {
    return bound(a) ? null : anonSegment(a);
  }
  if (isNestedBlock(a)) return anonSegment(a);
  // `catch (e)` binds e on the CatchClause, not inside its block, so without
  // this the binding escapes block segmentation and collides with same-named
  // locals elsewhere in the function.
  if (Node.isCatchClause(a)) return anonSegment(a);
  return null;
}

function scopePath(node: any): string[] {
  const out: string[] = [];
  for (let from = node, a = node.getParent?.(); a; from = a, a = a.getParent?.()) {
    if (Node.isSourceFile(a)) break;
    // `for (let i ...)` binds i on the statement, outside its body block, so two
    // loops in one function shared `fn.i`. Only the header gets the segment:
    // the body is already a nested block.
    const header = (Node.isForStatement(a) || Node.isForInStatement(a) || Node.isForOfStatement(a))
      && a.getStatement() !== from;
    const seg = header ? anonSegment(a) : scopeSegment(a);
    if (seg) out.unshift(seg);
  }
  return out;
}

// `export default function () {}` and `export default {...}` have no name.
// 11 of the 12 remaining flagged imports and 3 unresolved calls traced to this.
function isDefaultExport(node: any): boolean {
  try {
    if (node.hasModifier?.(SyntaxKind.DefaultKeyword)) return true;
    const p = node.getParent?.();
    return !!p && Node.isExportAssignment(p);
  } catch { return false; }
}

// An arrow or function expression with no binding of its own: a callback, an
// IIFE, or `inst._zod.parse = (payload, ctx) => ...`. Runtime frames land on
// these more than on anything else, so they are entities. Their id is the scope
// prefix their own parameters and locals already carry, unique by construction.
function isAnonymousFunction(node: any): boolean {
  if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) return false;
  const p = node.getParent();
  if (p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p) || Node.isPropertyDeclaration(p))) return false;
  return !(isDefaultExport(node) || (p && Node.isExportAssignment(p)));
}

function declName(node: any): string | null {
  // An arrow or function expression has no name of its own; it borrows the
  // binding it is assigned to. `const x = () => {}` is the dominant idiom in
  // this corpus, so without this the call site has no nameable container.
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const p = node.getParent();
    if (p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p)
              || Node.isPropertyDeclaration(p))) return declName(p);
    if (isDefaultExport(node) || (p && Node.isExportAssignment(p))) {
      return [...scopePath(node), "default"].join(".");
    }
    return [...scopePath(node), anonSegment(node)].join(".");
  }
  const own = Node.isConstructorDeclaration(node)
    ? "constructor"
    : (node.getName?.() || (isDefaultExport(node) ? "default" : null));
  if (!own) return null;
  return [...scopePath(node), own].join(".");
}

// THE invariant: declaration emission and call resolution both route entity
// ids through this function, so a resolved endpoint is closed by construction
// rather than by two code paths happening to agree on a string format.
function idOfNode(node: any): string | null {
  const name = declName(node);
  if (!name) return null;
  return eid(np(node.getSourceFile().getFilePath()), name);
}

function typeOfNode(node: any): string {
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isInterfaceDeclaration(node)) return "interface";
  if (Node.isTypeAliasDeclaration(node)) return "type";
  if (Node.isEnumDeclaration(node)) return "enum";
  if (Node.isFunctionDeclaration(node)) return "function";
  if (Node.isConstructorDeclaration(node)) return "constructor";
  // A MethodSignature/PropertySignature lives in TYPE space; a
  // MethodDeclaration/PropertyDeclaration lives in VALUE space. Collapsing both
  // to "method"/"property" made the declaration-space split misclassify them,
  // so `type DIRTY = { value: T }`'s member collided with `DIRTY`'s `value`
  // parameter, and `interface $constructor { init() }` with `function init()`.
  if (Node.isMethodSignature(node)) return "type-method";
  if (Node.isMethodDeclaration(node)) return "method";
  if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) return "accessor";
  if (Node.isPropertySignature(node)) return "type-property";
  if (Node.isPropertyDeclaration(node)) return "property";
  if (Node.isParameterDeclaration(node)) return "parameter";
  if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) return "property";
  if (Node.isBindingElement(node)) return "binding";
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer?.();
    // `const f = () => {}` is a function, not a variable holding one.
    return init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
      ? "function" : "variable";
  }
  if (isAnonymousFunction(node)) return "anonymous-function";
  // Falling back to a bare "unknown" hid what these actually were: 32 of them,
  // all namespace re-exports (`export * as z from ...`), which the export map
  // yields as nodes none of the branches above match. Naming the syntax kind
  // costs nothing and keeps the fallback auditable.
  const kind = node.getKindName?.();
  return kind ? kind.replace(/Declaration$|Expression$/, "").toLowerCase() : "unknown";
}

const isCallableContainer = (n: any) =>
  Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n)
  || Node.isConstructorDeclaration(n) || Node.isGetAccessorDeclaration(n)
  || Node.isSetAccessorDeclaration(n) || Node.isArrowFunction(n)
  || Node.isFunctionExpression(n);
function slug(s: string) { return s.replace(/\\/g, "/").replace(/[^a-zA-Z0-9_$/@.-]/g, "_"); }
function rel(p: string) { return path.relative(ROOT, p).replace(/\\/g, "/"); }
function np(p: string) { return p.replace(/\\/g, "/"); }

// Attribute a node to the nearest enclosing declared entity, falling back to
// the module. Shared by call and instantiation extraction so both sides of the
// fact base use one notion of "where did this happen".
// Attribute a node to the nearest enclosing entity. Prefer a callable
// container; failing that, the declaration whose initializer the node sits in.
//
// `export const parse = core._parse(ZodRealError)` has no callable ancestor, so
// this previously attributed the call to the module. Nothing calls a module, so
// every value-flow chain through a top-level initializer dead-ended there — and
// that is most of what made blast-radius queries shallow. Re-attributing those
// sites grows the transitive-caller closure of core `_parse` from 4 to 13.
const isDeclContainer = (n: any) =>
  Node.isVariableDeclaration(n) || Node.isPropertyAssignment(n)
  || Node.isPropertyDeclaration(n) || Node.isPropertySignature(n);

function callSite(node: any, moduleId: string) {
  let fallback: { callerId: string; callerKind: string } | null = null;
  for (let a = node.getParent(); a; a = a.getParent()) {
    // Static calls stay attributed to the nearest NAMED entity: nothing calls an anonymous function by name, so attributing to it would dead-end transitive-caller chains, the defect 2026-10-09b fixed for module attribution.
    if (isAnonymousFunction(a)) continue;
    const callable = isCallableContainer(a);
    if (!callable && !isDeclContainer(a)) continue;
    const id = idOfNode(a);
    if (!id) continue;
    const t = typeOfNode(a);
    const hit = { callerId: id, callerKind: t === "unknown" ? a.getKindName() : t };
    if (callable) return hit;
    fallback ??= hit;
  }
  return fallback ?? { callerId: moduleId, callerKind: "module" };
}

export { mid, rel, np, eid, isExternalPath, externalOrigin, declName, idOfNode, typeOfNode, isCallableContainer, callSite, isAnonymousFunction };
