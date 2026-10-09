import { Project, SyntaxKind, Node, ts, type SourceFile } from "ts-morph";
import * as path from "path";
import * as fs from "fs";
import { fingerprint } from "./fingerprint";

type Fact = DeclFact | ContainsFact | ImportFact | ReexportFact | CallsFact | HeritageFact | InstantiatesFact | ReferencesFact;

interface DeclFact {
  kind: "declaration";
  entityId: string;
  entityType: string;
  name: string;
  file: string;
  exported: boolean;
  // Content-addressed alternatives to entityId; see fingerprint.ts. Absent
  // when the node is not fingerprintable (modules, stubs, namespace re-exports).
  structureId?: string; // structure only: survives rename and move
  contentId?: string;   // name + structure: survives move, not rename
}

interface ContainsFact {
  kind: "contains";
  containerId: string;
  entityId: string;
}

interface ImportFact {
  kind: "import";
  importerFile: string;
  exportedBy: string;
  importedName: string;
  importType: string;
}

interface ReexportFact {
  kind: "reexport";
  barrel: string;
  source: string;
  reexportedName?: string;
}

interface CallsFact {
  kind: "calls";
  callerId: string;
  calleeName: string;
  calleeId?: string;
  confidence: number;
  reason: string;      // how the callee was resolved
  callerKind: string;  // what kind of entity the call site sits in
  file: string;
  line: number;        // distinct call sites are distinct facts
}

interface InstantiatesFact {
  kind: "instantiates";
  callerId: string;
  className: string;
  classId?: string;
  confidence: number;
  reason: string;
  callerKind: string;
  file: string;
  line: number;
}

// An identifier occurrence resolved to the entity it names, for occurrences
// that are NOT already the callee of a `calls` / `instantiates` fact. See
// extractReferences() for exactly what is and is not counted.
interface ReferencesFact {
  kind: "references";
  callerId: string;    // enclosing entity, same attribution as `calls`
  name: string;        // source text: `x`, or `ns.member` for a namespace member
  targetId?: string;
  ctx: string;         // value | type | typeof | shorthand | export | jsx
  confidence: number;
  reason: string;
  callerKind: string;
  file: string;
  line: number;
}

interface HeritageFact {
  kind: "extends" | "implements";
  childId: string;
  parentName: string;
}

const facts: Fact[] = [];
let ROOT = "";
// Files the walk actually visits. Resolution can land outside it — a benchmark
// instantiating a class from the excluded tests/ tree — and such an entity is
// real but never declared by the walk.
const ANALYSED = new Set<string>();

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
function anonSegment(node: any): string {
  const p = node.getParent?.();
  if (!p) return "@anon";
  const sibs = p.getChildren?.().filter((c: any) => c.getKind?.() === node.getKind()) ?? [];
  const i = sibs.findIndex((c: any) => c === node);
  return `@${node.getKindName().replace(/Expression$|Declaration$/, "").toLowerCase()}${i < 0 ? 0 : i}`;
}

// One segment of the lexical scope path, for ancestors that introduce a scope.
// Previously only classes and interfaces were consulted, via an `ownerName`
// that walked to the NEAREST class or interface. That produced three defects:
// members of object literals got a bare name, members of nested type literals
// got the enclosing interface's name (so `interface Foo { x: { y: T } }` yielded
// `Foo.y`, colliding with a real `Foo.y`), and parameters, bindings and locals
// were never qualified at all. 438 ids collided within value space as a result.
function scopeSegment(a: any): string | null {
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
  if (Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) return "method";
  if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) return "accessor";
  if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) return "property";
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
function rel(p: string) { return path.relative(ROOT, p).replace(/\\/g, "/"); }
function np(p: string) { return p.replace(/\\/g, "/"); }
function log(level: string, msg: string) {
  if (level !== "debug") process.stderr.write(`[${level}] ${msg}\n`);
}

// Resolve import specifier to file path
function resolveImport(fromFile: string, specifier: string): string | null {
  const dir = path.dirname(fromFile);
  // relative imports
  if (specifier.startsWith(".")) {
    const candidates = [
      specifier.replace(/\.js$/, ".ts"),
      specifier + ".ts",
      specifier.replace(/\.js$/, "/index.ts"),
      specifier + "/index.ts",
      specifier.replace(/\.js$/, ".d.ts"),
      path.join(specifier.replace(/\.js$/, ""), "index.ts"),
    ];
    for (const c of candidates) {
      const full = path.resolve(dir, c);
      if (fs.existsSync(full)) return full;
    }
    return null; // relative but unresolvable
  }
  // ponytail: bare specifiers are treated as external. tsconfig `paths`
  // aliases that point back into the repo (zod's own `zod/v3`) land here
  // wrongly; read compilerOptions.paths if alias-heavy repos matter.
  return null; // external package — has no path inside this repo
}

// JSDoc extraction (guarded)
function jsdoc(node: any): string | undefined {
  try {
    if (typeof node.getJsDocs === "function") {
      return node.getJsDocs().map((d: any) => d.getDescription()).join("\n") || undefined;
    }
  } catch {}
  return undefined;
}

function extractCalleeName(expr: any): string | null {
  if (Node.isIdentifier(expr)) return expr.getText();
  if (Node.isPropertyAccessExpression(expr)) return expr.getText();
  return null;
}

// Heritage clauses live on both exported and non-exported classes/interfaces.
// Emitting them from one call site only silently drops the non-exported half.
function emitHeritage(node: any, id: string) {
  if (!Node.isClassDeclaration(node) && !Node.isInterfaceDeclaration(node)) return;
  try {
    for (const h of node.getHeritageClauses?.() || []) {
      // `class C extends B implements I` yields two clauses; the token
      // distinguishes them. Emitting both as "extends" merged two distinct
      // relations into a single fact type. getToken() returns a SyntaxKind
      // enum value, not a node — comparing its .getText() silently never matched.
      const kind = h.getToken() === SyntaxKind.ImplementsKeyword ? "implements" as const : "extends" as const;
      for (const t of h.getTypeNodes() || []) {
        facts.push({ kind, childId: id, parentName: t.getText() });
      }
    }
  } catch {}
}

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

// Resolve a name node to a declared entity id, declaring dependency entities
// on first reference since the file walk never visits them.
function resolveEntity(node: any): string | null {
  try {
    const defs = node.getDefinitions();
    if (!defs.length) return null;
    const defNode = defs[0].getDeclarationNode();
    if (!defNode) return null;
    const id = idOfNode(defNode);
    if (!id) return null;
    // Anything the walk never visits must be declared here or the edge
    // resolves to an id the fact base does not contain.
    const defFile = np(defNode.getSourceFile().getFilePath());
    if (!ANALYSED.has(defFile)) {
      const external = isExternalPath(defFile);
      facts.push({
        kind: "declaration", entityId: id,
        entityType: external ? "external" : "out_of_scope",
        name: declName(defNode)!,
        file: external ? `external:${externalOrigin(defFile)}` : rel(defFile),
        exported: true,
      });
    }
    return id;
  } catch { return null; }
}


// ─── References ───────────────────────────────────────────────────────────
// COUNTED: every Identifier occurrence in value position (`foo`, `[a, b]`,
// `x = defaultErrorMap`), in type position (`Foo` in `: Foo`, `typeof x`,
// `implements Foo`), JSX tag names, local `export { x }`, shorthand properties
// (`{ x }` names the variable x as well as declaring a property), and the
// member of a property access / qualified name whose receiver is a namespace
// import (`core.$ZodType`, `util.Foo`) — the receiver alone is skipped.
//
// NOT COUNTED (tallied in refSkips so the exclusion is auditable):
//  - callees of CallExpression / NewExpression: already `calls`/`instantiates`
//  - declaration names (the identifier that introduces a binding)
//  - import bindings and `export ... from` specifiers: `import` / `reexport` facts
//  - `obj.prop` where obj is not a namespace import: member access on a value
//    is dispatch on a runtime type, not a reference to a declared name
//    (shortcut: `this.def`-style reads are the bulk of this and are skipped;
//    upgrade when a "field read" edge is wanted)
//  - labels, type predicates, JSX closing tags, binding-pattern keys
//  - references to type parameters (`T`): not entities, nothing declares them
//  - references to function-local bindings (parameters, locals), unless
//    ATLAS_REFS_LOCAL=1: they never cross an entity boundary and would
//    dominate the fact base (see report.md)
const refSkips: Record<string, number> = Object.create(null);
const refSkip = (why: string) => { refSkips[why] = (refSkips[why] || 0) + 1; return null; };
const emitLocalRefs = process.env.ATLAS_REFS_LOCAL === "1";

// True when the name denotes a module/namespace rather than a value or type:
// `import * as ns`, `import { ns }` of an `export * as ns`, or the `ns` in
// `core.ns`. Follows the alias chain, so it is robust to re-export spelling.
function nsTarget(n: any): any {
  const last = Node.isPropertyAccessExpression(n) ? n.getNameNode()
    : Node.isQualifiedName(n) ? n.getRight() : n;
  if (!Node.isIdentifier(last)) return null;
  let sym = last.getSymbol();
  if (sym?.isAlias()) sym = sym.getAliasedSymbol() ?? sym;
  return sym?.getDeclarations().find((d: any) => Node.isSourceFile(d) || Node.isModuleDeclaration(d)) ?? null;
}
const isNamespaceId = (n: any) => !!nsTarget(n);
const isReceiver = (n: any) => {
  const p = n.getParent();
  return (Node.isPropertyAccessExpression(p) && p.getExpression() === n)
    || (Node.isQualifiedName(p) && p.getLeft() === n);
};
const isCalleeOf = (n: any) => {
  const p = n.getParent();
  return (Node.isCallExpression(p) || Node.isNewExpression(p)) && p.getExpression() === n;
};

// Which space the occurrence lives in, looking through `a.b.c` / `A.B.C`.
function refSpace(id: any): string {
  let top = id;
  while (true) {
    const p = top.getParent();
    if ((Node.isPropertyAccessExpression(p) && p.getExpression() === top)
        || (Node.isQualifiedName(p) && p.getLeft() === top)
        || (Node.isPropertyAccessExpression(p) && p.getNameNode() === top)
        || (Node.isQualifiedName(p) && p.getRight() === top)) { top = p; continue; }
    if (Node.isTypeReference(p)) return "type";
    if (Node.isTypeQuery(p)) return "typeof";
    if (Node.isExpressionWithTypeArguments(p)) {
      const h = p.getParent();
      const runtime = Node.isHeritageClause(h) && h.getToken() === SyntaxKind.ExtendsKeyword
        && (Node.isClassDeclaration(h.getParent()) || Node.isClassExpression(h.getParent()));
      return runtime ? "value" : "type";
    }
    return "value";
  }
}

// null = not counted (and why, via refSkip). Otherwise the ctx string.
function refContext(id: any): string | null {
  const p = id.getParent();
  if (!p) return refSkip("no-parent");
  if (id.compilerNode.flags & ts.NodeFlags.JSDoc) return refSkip("jsdoc");
  if (id.getText() === "undefined") return refSkip("undefined-literal");
  if (id.getText() === "const" && Node.isTypeReference(p)) return refSkip("as-const");
  if (Node.isImportSpecifier(p) || Node.isImportClause(p) || Node.isNamespaceImport(p)
      || Node.isImportEqualsDeclaration(p) || Node.isNamespaceExport(p)) return refSkip("import-binding");
  if (Node.isExportSpecifier(p)) {
    if (p.getExportDeclaration().hasModuleSpecifier()) return refSkip("reexport-specifier");
    return p.getNameNode() === id ? "export" : refSkip("export-alias");
  }
  if (Node.isPropertyAccessExpression(p) || Node.isQualifiedName(p)) {
    const isName = Node.isPropertyAccessExpression(p) ? p.getNameNode() === id : p.getRight() === id;
    const recv = Node.isPropertyAccessExpression(p) ? p.getExpression() : p.getLeft();
    if (isName) {
      if (isCalleeOf(p)) return refSkip("callee");
      // `core.util` is a namespace used only to reach `core.util.X`: the next
      // hop carries the reference.
      if (isReceiver(p) && isNamespaceId(id)) return refSkip("namespace-receiver");
      return isNamespaceId(recv) ? refSpace(id) : refSkip("member-access");
    }
    if (isNamespaceId(id)) return refSkip("namespace-receiver");
  }
  if (isCalleeOf(id)) return refSkip("callee");
  if (Node.isShorthandPropertyAssignment(p)) return "shorthand";
  if (Node.isBindingElement(p) && p.getPropertyNameNode() === id) return refSkip("binding-key");
  if (Node.isLabeledStatement(p) || Node.isBreakStatement(p) || Node.isContinueStatement(p)) return refSkip("label");
  if (Node.isTypePredicate(p)) return refSkip("type-predicate");
  if (Node.isJsxClosingElement(p)) return refSkip("jsx-closing");
  if (Node.isJsxOpeningElement(p) || Node.isJsxSelfClosingElement(p)) {
    if (p.getTagNameNode() === id) return "jsx";
  }
  if ((p as any).getNameNode?.() === id) return refSkip("declaration-name");
  return refSpace(id);
}

function extractReferences(file: SourceFile, fp: string, moduleId: string) {
  const checker = project.getTypeChecker();
  for (const id of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const ctx = refContext(id);
    if (!ctx) continue;
    const p = id.getParent();

    // The declaration the occurrence names — used only to classify it (type
    // parameter? function-local?). The id itself still comes from resolveEntity.
    let decl: any;
    let nameNode: any = id;
    if (ctx === "shorthand") {
      decl = checker.getShorthandAssignmentValueSymbol(p)?.getDeclarations()[0];
      nameNode = decl?.getNameNode?.() ?? id; // resolve the variable, not the property
    } else {
      decl = id.getSymbol()?.getDeclarations()[0];
    }
    if (decl && Node.isTypeParameterDeclaration(decl)) { refSkip("type-parameter"); continue; }
    if (decl && !emitLocalRefs && decl.getFirstAncestor(isCallableContainer)) { refSkip("function-local"); continue; }

    let targetId: string | undefined;
    let reason = "unresolved";
    const ns = nsTarget(id);
    if (ns) {
      // A namespace used as a value refers to the module itself.
      const src = Node.isSourceFile(ns) ? ns : null;
      if (src && ANALYSED.has(np(src.getFilePath()))) { targetId = mid(np(src.getFilePath())); reason = "namespace"; }
    } else {
      targetId = resolveEntity(nameNode) ?? undefined;
      if (targetId) reason = "resolved";
    }
    const site = callSite(id, moduleId);
    const name = Node.isPropertyAccessExpression(p) && p.getNameNode() === id ? p.getText()
      : Node.isQualifiedName(p) && p.getRight() === id ? p.getText() : id.getText();
    facts.push({
      kind: "references", callerId: site.callerId, name, targetId, ctx,
      confidence: targetId ? 0.9 : 0.3, reason, callerKind: site.callerKind,
      file: rel(fp), line: id.getStartLineNumber(),
    });
  }
}

function extractFile(file: SourceFile) {
  const fp = np(file.getFilePath());

  // ── Module identity ──
  const moduleId = mid(fp);

  // ── Top-level declarations from export map ──
  try {
    const exportedDecls = file.getExportedDeclarations();
    for (const [name, nodes] of exportedDecls) {
      for (const node of nodes) {
        // Use the declaration's actual source file (for re-exports, this is the original file, not the barrel)
        const defFile = np(node.getSourceFile().getFilePath());
        if (isExternalPath(defFile)) continue;
        // The export map keys by exported name; idOfNode keys by declared name.
        // They differ under `export { a as b }`, so record both when they do.
        const id = idOfNode(node) ?? eid(defFile, name);
        const dn = declName(node) ?? name;
        facts.push({ kind: "declaration", entityId: id, entityType: typeOfNode(node), name: dn, file: rel(defFile), exported: true, ...fingerprint(node, dn) });
        facts.push({ kind: "contains", containerId: mid(defFile), entityId: id });
        emitHeritage(node, id);
      }
    }
  } catch (e: any) {
    log("warn", `Exported declarations failed for ${rel(fp)}: ${e.message}`);
  }

  // ── Module entity ──
  // Calls made at module top level need a container that is itself a declared
  // entity. Previously they were attributed to a synthesized `toplevel_<line>`
  // id that nothing ever declared, so the edge dangled at its source.
  facts.push({ kind: "declaration", entityId: moduleId, entityType: "module", name: rel(fp), file: rel(fp), exported: true });

  // ── All declarations, exported or not, nested or not ──
  // Walking only top-level classes/interfaces/functions/type-aliases left
  // methods, constructors, accessors, nested functions and arrow-bound consts
  // undeclared. Calls from inside them had no resolvable container.
  const emitDecl = (node: any) => {
    const declFile = np(node.getSourceFile().getFilePath());
    if (isExternalPath(declFile)) return;
    const id = idOfNode(node);
    if (!id) return;
    facts.push({
      kind: "declaration", entityId: id, entityType: typeOfNode(node),
      name: declName(node)!, file: rel(declFile), exported: !!node.isExported?.(),
      ...fingerprint(node, declName(node)!),
    });
    facts.push({ kind: "contains", containerId: mid(declFile), entityId: id });
    emitHeritage(node, id);
  };

  const DECL_KINDS = [
    SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration,
    SyntaxKind.FunctionDeclaration, SyntaxKind.TypeAliasDeclaration,
    SyntaxKind.EnumDeclaration, SyntaxKind.MethodDeclaration,
    SyntaxKind.MethodSignature, SyntaxKind.Constructor,
    SyntaxKind.GetAccessor, SyntaxKind.SetAccessor,
    SyntaxKind.PropertyDeclaration, SyntaxKind.PropertySignature,
    SyntaxKind.VariableDeclaration,
    // Callable bindings that are not class members: parameters holding
    // callbacks (`fn`, `checker`, `getter`) and object-literal members
    // (`safeParse`, `toJSONSchema`). Calls target these directly, so without
    // them the edge resolves to an id nothing declares.
    SyntaxKind.Parameter, SyntaxKind.PropertyAssignment,
    // ShorthandPropertyAssignment is deliberately NOT a declaration: `{ shape }`
    // means `{ shape: shape }`, so it is a reference to an existing binding, not
    // a new entity. Declaring it made `const shape` and the shorthand collide on
    // one id in the same scope. The reference pass already covers the use.
    SyntaxKind.BindingElement,
  ];
  for (const k of DECL_KINDS) {
    for (const node of file.getDescendantsOfKind(k)) emitDecl(node);
  }

  // ── Calls ──
  const callExprs = file.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExprs) {
    const expr = call.getExpression();
    const calleeName = extractCalleeName(expr);
    if (!calleeName) continue;

    // Attribute the call to the nearest enclosing declared entity, falling back
    // to the module. The previous walk stopped at the first function or method
    // ancestor and, failing that, synthesized `anon_<line>` / `toplevel_<line>`
    // ids that no declaration fact backed — 3,025 of 4,385 edges dangled at
    // their source as a result.
    const site = callSite(call, moduleId);
    let callerId = site.callerId;
    let callerKind = site.callerKind;
    let confidence = 0.3;
    let reason = "unresolved";

    // Try to resolve callee via TypeScript's symbol system
    let calleeId: string | undefined;
    const resolveVia = (node: any, conf: number, why: string) => {
      const id = resolveEntity(node);
      if (!id) return;
      calleeId = id; confidence = conf; reason = why;
    };

    if (Node.isIdentifier(expr)) {
      resolveVia(expr, 0.9, "resolved");
    } else if (Node.isPropertyAccessExpression(expr)) {
      // Method/property calls (obj.method()) resolve through the type checker
      // via the language service's go-to-definition on the property name node.
      resolveVia(expr.getNameNode(), 0.8, "resolved_method");
    }

    // Location keeps two calls from the same caller to the same callee as two
    // facts. Without it, deduplication collapses call-site multiplicity — which
    // the old synthesized `toplevel_<line>` caller ids were accidentally
    // preserving.
    facts.push({
      kind: "calls", callerId, calleeName, calleeId, confidence, reason, callerKind,
      file: rel(fp), line: call.getStartLineNumber(),
    });
  }

  // ── Instantiations ──
  // `new X()` is a NewExpression, not a CallExpression, so it produced no fact
  // of any kind. Every dependency that exists only to be instantiated —
  // `new ZodError(...)` in Zod — looked like an unused import.
  for (const ne of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const expr = ne.getExpression();
    const className = extractCalleeName(expr);
    if (!className) continue;
    const nameNode = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
    const classId = resolveEntity(nameNode) ?? undefined;
    const site = callSite(ne, moduleId);
    facts.push({
      kind: "instantiates", callerId: site.callerId, className, classId,
      confidence: classId ? 0.9 : 0.3, reason: classId ? "resolved" : "unresolved",
      callerKind: site.callerKind, file: rel(fp), line: ne.getStartLineNumber(),
    });
  }

  extractReferences(file, fp, moduleId);

  // ── Imports ──
  const mkImport = (imp: any) => {
    const msv = imp.getModuleSpecifierValue();
    const resolved = resolveImport(fp, msv);
    const isType = imp.isTypeOnly?.() || false;
    const defaultImport = imp.getDefaultImport?.();
    const namespaceImport = imp.getNamespaceImport?.();
    const namedImports = imp.getNamedImports?.() || [];

    const exportedBy = resolved ? rel(resolved) : `external:${msv}`;

    if (defaultImport) {
      facts.push({ kind: "import", importerFile: rel(fp), exportedBy, importedName: defaultImport.getText(), importType: isType ? "type-default" : "default" });
    }
    if (namespaceImport) {
      facts.push({ kind: "import", importerFile: rel(fp), exportedBy, importedName: namespaceImport.getText(), importType: isType ? "type-namespace" : "namespace" });
    }
    for (const ni of namedImports) {
      facts.push({ kind: "import", importerFile: rel(fp), exportedBy, importedName: ni.getName(), importType: isType || ni.isTypeOnly() ? "type-named" : "named" });
    }
  };

  for (const imp of file.getImportDeclarations()) {
    try { mkImport(imp); } catch {}
  }

  // ── Re-exports ──
  for (const exp of file.getExportDeclarations()) {
    const msv = exp.getModuleSpecifierValue?.();
    if (!msv) continue; // export { x } without "from"
    const resolved = resolveImport(fp, msv);
    const source = resolved ? rel(resolved) : `external:${msv}`;
    const named = exp.getNamedExports?.() || [];
    if (named.length > 0) {
      for (const ne of named) {
        facts.push({ kind: "reexport", barrel: rel(fp), source, reexportedName: ne.getName() });
      }
    } else {
      facts.push({ kind: "reexport", barrel: rel(fp), source });
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

// ATLAS_TARGET / ATLAS_TSCONFIG / ATLAS_OUT let history runs point at another checkout
// without overwriting the committed facts.json; defaults are the baseline run.
const TARGET = path.resolve(process.env.ATLAS_TARGET ?? path.resolve(__dirname, "zod-repo/packages/zod/src"));
ROOT = TARGET;
const TSCONFIG = path.resolve(process.env.ATLAS_TSCONFIG ?? path.resolve(__dirname, "zod-repo/packages/zod/tsconfig.json"));

const project = new Project({
  tsConfigFilePath: TSCONFIG,
  skipAddingFilesFromTsConfig: false,
});

const sourceFiles = project.getSourceFiles().filter(f => {
  const fp = np(f.getFilePath());
  return fp.startsWith(np(TARGET))
    && !fp.includes("/tests/")
    && !fp.includes(".test.");
});

for (const f of sourceFiles) ANALYSED.add(np(f.getFilePath()));

log("info", `Found ${sourceFiles.length} source files`);

for (const file of sourceFiles) {
  try {
    extractFile(file);
  } catch (e: any) {
    log("error", `FAILED ${rel(file.getFilePath())}: ${e.message}`);
  }
}

// Deduplicate
const seen = new Set<string>();
const unique: Fact[] = [];
for (const f of facts) {
  const key = JSON.stringify(f);
  if (!seen.has(key)) { seen.add(key); unique.push(f); }
}

// Write
const OUT = path.resolve(process.env.ATLAS_OUT ?? path.resolve(__dirname, "facts.json"));
fs.writeFileSync(OUT, JSON.stringify(unique, null, 2));
log("info", `Wrote ${unique.length} facts to ${OUT}`);

// Stats
const kinds: Record<string, number> = Object.create(null);
for (const f of unique) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
log("info", `By kind: ${JSON.stringify(kinds)}`);

const decls = unique.filter(f => f.kind === "declaration") as DeclFact[];
const types: Record<string, number> = Object.create(null);
for (const d of decls) types[d.entityType] = (types[d.entityType] || 0) + 1;
log("info", `Decl by type: ${JSON.stringify(types)}`);

const calls = unique.filter(f => f.kind === "calls") as CallsFact[];
const confs: Record<string, number> = Object.create(null);
for (const c of calls) {
  const b = Math.round(c.confidence * 10) / 10 + "";
  confs[b] = (confs[b] || 0) + 1;
}
log("info", `Call confidence: ${JSON.stringify(confs)}`);
log("info", `Resolved calls: ${calls.filter(c => c.calleeId).length} of ${calls.length}`);

// ─── Referential integrity ─────────────────────────────────────────────
// The invariant: every endpoint of a `calls` fact names an entity the fact
// base declares, or is explicitly unresolved. A fact base that resolves an
// edge to an id nothing declares reports false confidence — the edge looks
// resolved and is unusable. Measured at 16.8% closure before this check
// existed, which no test caught because nothing asserted it.
const declaredIds = new Set(
  unique.filter(f => f.kind === "declaration").map(f => (f as DeclFact).entityId)
);
const instantiations = unique.filter(f => f.kind === "instantiates") as InstantiatesFact[];
const edges: { callerId: string; targetId?: string; file: string; line: number }[] = [
  ...calls.map(c => ({ callerId: c.callerId, targetId: c.calleeId, file: c.file, line: c.line })),
  ...instantiations.map(i => ({ callerId: i.callerId, targetId: i.classId, file: i.file, line: i.line })),
];
// Reference edges obey the same invariant but are kept out of the
// calls+instantiations closure figure, which is a tracked metric.
const refs = unique.filter(f => f.kind === "references") as ReferencesFact[];
const refEdges = refs.map(r => ({ callerId: r.callerId, targetId: r.targetId, file: r.file, line: r.line }));
const violations = [...edges, ...refEdges].flatMap(e => {
  const bad: string[] = [];
  if (!declaredIds.has(e.callerId)) bad.push(`caller ${e.callerId}`);
  if (e.targetId && !declaredIds.has(e.targetId)) bad.push(`target ${e.targetId}`);
  return bad.map(b => `${e.file}:${e.line} ${b}`);
});
const closed = edges.filter(e => e.targetId && declaredIds.has(e.callerId) && declaredIds.has(e.targetId));
log("info", `Instantiations: ${instantiations.filter(i => i.classId).length} of ${instantiations.length} resolved`);
log("info", `Closed edges (calls + instantiations): ${closed.length} of ${edges.length} (${(100 * closed.length / edges.length).toFixed(1)}%)`);

const refCtx: Record<string, number> = Object.create(null);
for (const r of refs) refCtx[r.ctx] = (refCtx[r.ctx] || 0) + 1;
const refClosed = refEdges.filter(e => e.targetId && declaredIds.has(e.callerId) && declaredIds.has(e.targetId));
log("info", `References: ${refs.length} (${refs.filter(r => r.targetId).length} resolved), by ctx ${JSON.stringify(refCtx)}`);
log("info", `Closed reference edges: ${refClosed.length} of ${refEdges.length}`);
log("info", `Reference occurrences not counted: ${JSON.stringify(refSkips)}`);

// Second integrity property: an entity id names exactly one entity. The check
// above only asks whether an endpoint is declared, not whether the id is
// unambiguous. Path-and-name ids collide two ways here — TypeScript
// declaration merging (a `const` and a `type` of the same name, which is one
// entity in two halves) and genuine collision (a type alias and a class
// property both called `output` in one module, which is two entities sharing
// an id). Reported, not enforced: which of those the schema should tolerate is
// exactly the symbol-identity question thesis.md §4.4 leaves open.
const typesById = new Map<string, Set<string>>();
for (const d of unique.filter(f => f.kind === "declaration") as DeclFact[]) {
  if (!typesById.has(d.entityId)) typesById.set(d.entityId, new Set());
  typesById.get(d.entityId)!.add(d.entityType);
}
// Split by TypeScript declaration space. A merged symbol (`interface X` plus
// `const X`) is ONE entity declared twice, which ADR-0001 decision 2 holds to
// be correct, so counting it as ambiguity over-reports. Two declarations in the
// SAME space sharing an id are genuinely two entities and a real defect.
const SPACE: Record<string, string> = {
  interface: "type", type: "type", class: "both", enum: "both",
  module: "ns", sourcefile: "ns",
};
const space = (t: string) => SPACE[t] ?? "value";
const ambiguous = [...typesById].filter(([, t]) => t.size > 1);
const withinSpace = ambiguous.filter(([, t]) => {
  const sp = new Set([...t].map(space));
  return sp.size === 1 && !sp.has("both");
});
log("info", `Entity ids with multiple entityTypes: ${ambiguous.length} of ${typesById.size}`);
log("info", `  cross-space (declaration merges, expected): ${ambiguous.length - withinSpace.length}`);
log("info", `  within one space (genuine collisions): ${withinSpace.length}`);
for (const [id, t] of withinSpace.slice(0, 4)) log("info", `    ${id} -> ${[...t].join(", ")}`);
// shortcut: block scopes (if/for/try bodies) contribute no path segment, so a
// parameter and a local of the same name in sibling blocks of one function still
// collide. That is the whole of the residual. Enforce once blocks are segmented.

// Collision measure per id scheme. An "entity" is a distinct (file, name,
// entityType); an id collides when it is shared by 2+ entities. Ids are
// compared only over facts that carry that scheme (module/stub facts have no
// content ids). entityId collisions are by construction the ambiguity above.
for (const scheme of ["entityId", "contentId", "structureId"] as const) {
  const byId = new Map<string, { ents: Set<string>; types: Set<string> }>();
  for (const d of decls) {
    const id = d[scheme];
    if (!id) continue;
    const e = byId.get(id) ?? { ents: new Set(), types: new Set() };
    e.ents.add(`${d.file}|${d.name}|${d.entityType}`); e.types.add(d.entityType);
    byId.set(id, e);
  }
  const coll = [...byId].filter(([, e]) => e.ents.size > 1);
  const ents = new Set<string>(); for (const [, e] of byId) for (const x of e.ents) ents.add(x);
  const inColl = coll.reduce((n, [, e]) => n + e.ents.size, 0);
  const worst = coll.sort((a, b) => b[1].ents.size - a[1].ents.size)[0];
  log("info", `${scheme}: ${byId.size} ids / ${ents.size} entities; colliding ids ${coll.length} (${(100 * coll.length / byId.size).toFixed(1)}%), entities in them ${inColl} (${(100 * inColl / ents.size).toFixed(1)}%); multi-type ids ${[...byId].filter(([, e]) => e.types.size > 1).length}; worst ${worst ? worst[1].ents.size + "x " + worst[0] : "-"}`);
}

if (violations.length > 0) {
  log("error", `REFERENTIAL INTEGRITY: ${violations.length} edge endpoints reference undeclared entities`);
  for (const v of violations.slice(0, 20)) log("error", `  ${v}`);
  process.exitCode = 1;
} else {
  log("info", "Referential integrity: OK (every edge endpoint is declared or explicitly unresolved)");
}
