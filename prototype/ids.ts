// SPIKE SNAPSHOT of extract.ts (identity + enclosing-entity logic), copied
// verbatim so trace.ts computes ids with the SAME functions the extractor uses,
// without editing extract.ts (it runs on import and exports nothing).
// Source ranges: extract.ts 96-310, 398-416, 312. Re-copy by hand if extract.ts identity logic changes.
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

// The class or interface a member belongs to. Members are qualified by owner
// because a bare method name is not unique within a file — Zod declares
// `_parse` on many types in one module.
const isMember = (node: any) =>
  Node.isMethodDeclaration(node) || Node.isMethodSignature(node)
  || Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)
  || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node);

// An anonymous function that is not bound to a name — a callback passed
// straight into a call, as in `$constructor("ZodString", (inst, def) => {...})`.
// Its parameters and locals need some disambiguator or they collide with every
// other callback's `inst` in the same file.
// shortcut: positional index among same-kind siblings of the parent node. Shifts
// if a sibling callback is inserted before it; a stable scheme would need the
// enclosing call's callee name, which is not always resolvable at this point.
// Index among same-kind anonymous nodes under the nearest NAMED ancestor, in
// document order. Indexing within the immediate parent gave every sibling in a
// promise chain the same segment: `.then(() => {...}).then((x) => {...})` has
// two arrows with different parents, each index 0 in its own parent, so a local
// in the first collided with a parameter of the second.
// shortcut: still positional, so inserting an earlier sibling shifts it. A
// stable scheme needs the enclosing call's callee name, which is not always
// resolvable here.
function anonSegment(node: any): string {
  const kindTag = `@${node.getKindName().replace(/Expression$|Declaration$/, "").toLowerCase()}`;
  let anchor: any = null;
  for (let a = node.getParent?.(); a; a = a.getParent?.()) {
    if (Node.isSourceFile(a)) { anchor = a; break; }
    if (namedSegment(a)) { anchor = a; break; }
  }
  if (!anchor) return `${kindTag}0`;
  const sibs = anchor.getDescendantsOfKind?.(node.getKind()) ?? [];
  const i = sibs.findIndex((c: any) => c === node);
  return `${kindTag}${i < 0 ? 0 : i}`;
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
  for (let a = node.getParent?.(); a; a = a.getParent?.()) {
    if (Node.isSourceFile(a)) break;
    const seg = scopeSegment(a);
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
    return null;
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
const isDeclContainer = (n: any) =>
  Node.isVariableDeclaration(n) || Node.isPropertyAssignment(n)
  || Node.isPropertyDeclaration(n) || Node.isPropertySignature(n);

function callSite(node: any, moduleId: string) {
  let fallback: { callerId: string; callerKind: string } | null = null;
  for (let a = node.getParent(); a; a = a.getParent()) {
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


export { idOfNode, typeOfNode, callSite, isCallableContainer, declName, mid };
function np(p: string) { return p.replace(/\\/g, "/"); }
