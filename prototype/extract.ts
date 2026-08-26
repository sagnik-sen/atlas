import { Project, SyntaxKind, Node, type SourceFile } from "ts-morph";
import * as path from "path";
import * as fs from "fs";

type Fact = DeclFact | ContainsFact | ImportFact | ReexportFact | CallsFact | HeritageFact | InstantiatesFact;

interface DeclFact {
  kind: "declaration";
  entityId: string;
  entityType: string;
  name: string;
  file: string;
  exported: boolean;
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
function ownerName(node: any): string | null {
  const owner = node.getFirstAncestor?.((a: any) =>
    Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isClassExpression(a));
  return owner?.getName?.() || null;
}

const isMember = (node: any) =>
  Node.isMethodDeclaration(node) || Node.isMethodSignature(node)
  || Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)
  || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node);

function declName(node: any): string | null {
  if (Node.isConstructorDeclaration(node)) {
    const o = ownerName(node);
    return o ? `${o}.constructor` : null;
  }
  // An arrow or function expression has no name of its own; it borrows the
  // binding it is assigned to. `const x = () => {}` is the dominant idiom in
  // this corpus, so without this the call site has no nameable container.
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const p = node.getParent();
    if (p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p)
              || Node.isPropertyDeclaration(p))) return declName(p);
    return null;
  }
  const n = node.getName?.();
  if (!n) return null;
  if (isMember(node)) {
    const o = ownerName(node);
    return o ? `${o}.${n}` : n;
  }
  return n;
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
function callSite(node: any, moduleId: string) {
  for (let a = node.getParent(); a; a = a.getParent()) {
    if (!isCallableContainer(a)) continue;
    const id = idOfNode(a);
    if (id) {
      const t = typeOfNode(a);
      return { callerId: id, callerKind: t === "unknown" ? a.getKindName() : t };
    }
  }
  return { callerId: moduleId, callerKind: "module" };
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
        facts.push({ kind: "declaration", entityId: id, entityType: typeOfNode(node), name: declName(node) ?? name, file: rel(defFile), exported: true });
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
    SyntaxKind.ShorthandPropertyAssignment, SyntaxKind.BindingElement,
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
      facts.push({ kind: "import", importerFile: rel(fp), exportedBy, importedName: namespaceImport.getText(), importType: "namespace" });
    }
    for (const ni of namedImports) {
      facts.push({ kind: "import", importerFile: rel(fp), exportedBy, importedName: ni.getName(), importType: isType ? "type-named" : "named" });
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

const TARGET = path.resolve(__dirname, "zod-repo/packages/zod/src");
ROOT = TARGET;
const TSCONFIG = path.resolve(__dirname, "zod-repo/packages/zod/tsconfig.json");

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
const OUT = path.resolve(__dirname, "facts.json");
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
const violations = edges.flatMap(e => {
  const bad: string[] = [];
  if (!declaredIds.has(e.callerId)) bad.push(`caller ${e.callerId}`);
  if (e.targetId && !declaredIds.has(e.targetId)) bad.push(`target ${e.targetId}`);
  return bad.map(b => `${e.file}:${e.line} ${b}`);
});
const closed = edges.filter(e => e.targetId && declaredIds.has(e.callerId) && declaredIds.has(e.targetId));
log("info", `Instantiations: ${instantiations.filter(i => i.classId).length} of ${instantiations.length} resolved`);
log("info", `Closed edges (calls + instantiations): ${closed.length} of ${edges.length} (${(100 * closed.length / edges.length).toFixed(1)}%)`);

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
const ambiguous = [...typesById].filter(([, t]) => t.size > 1);
log("info", `Ambiguous entity ids (one id, multiple entityTypes): ${ambiguous.length} of ${typesById.size}`);
for (const [id, t] of ambiguous.slice(0, 5)) log("info", `  ${id} -> ${[...t].join(", ")}`);

if (violations.length > 0) {
  log("error", `REFERENTIAL INTEGRITY: ${violations.length} edge endpoints reference undeclared entities`);
  for (const v of violations.slice(0, 20)) log("error", `  ${v}`);
  process.exitCode = 1;
} else {
  log("info", "Referential integrity: OK (every edge endpoint is declared or explicitly unresolved)");
}
