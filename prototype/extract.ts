import { Project, SyntaxKind, Node, type SourceFile } from "ts-morph";
import * as path from "path";
import * as fs from "fs";

type Fact = DeclFact | ContainsFact | ImportFact | ReexportFact | CallsFact | HeritageFact;

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
  reason: string;
}

interface HeritageFact {
  kind: "extends" | "implements";
  childId: string;
  parentName: string;
}

const facts: Fact[] = [];
let ROOT = "";

function mid(file: string) { return `module:${slug(path.relative(ROOT, file))}`; }
function eid(file: string, name: string) { return `ts:${slug(path.relative(ROOT, file))}:${name}`; }
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
    return specifier; // unresolved
  }
  return specifier; // external package
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

function extractFile(file: SourceFile) {
  const fp = np(file.getFilePath());

  // ── Module identity ──
  const moduleId = mid(fp);

  // ── Top-level declarations from export map ──
  try {
    const exportedDecls = file.getExportedDeclarations();
    for (const [name, nodes] of exportedDecls) {
      for (const node of nodes) {
        const ty = Node.isClassDeclaration(node) ? "class"
          : Node.isInterfaceDeclaration(node) ? "interface"
          : Node.isFunctionDeclaration(node) ? "function"
          : Node.isTypeAliasDeclaration(node) ? "type"
          : Node.isEnumDeclaration(node) ? "enum"
          : Node.isVariableDeclaration(node) ? "variable"
          : "unknown";

        // Use the declaration's actual source file (for re-exports, this is the original file, not the barrel)
        const defFile = np(node.getSourceFile().getFilePath());
        const id = eid(defFile, name);
        facts.push({ kind: "declaration", entityId: id, entityType: ty, name, file: rel(defFile), exported: true });
        facts.push({ kind: "contains", containerId: mid(defFile), entityId: id });

        emitHeritage(node, id);
      }
    }
  } catch (e: any) {
    log("warn", `Exported declarations failed for ${rel(fp)}: ${e.message}`);
  }

  // ── Non-exported declarations ──
  const processDecls = (declarations: any[], type: string) => {
    for (const d of declarations) {
      if (d.isExported?.()) continue;
      const name = d.getName?.();
      if (!name) continue;
      const id = eid(fp, name);
      facts.push({ kind: "declaration", entityId: id, entityType: type, name, file: rel(fp), exported: false });
      facts.push({ kind: "contains", containerId: moduleId, entityId: id });
      emitHeritage(d, id);
    }
  };
  processDecls(file.getClasses(), "class");
  processDecls(file.getInterfaces(), "interface");
  processDecls(file.getFunctions(), "function");
  processDecls(file.getTypeAliases(), "type");

  // ── Calls ──
  const callExprs = file.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of callExprs) {
    const expr = call.getExpression();
    const calleeName = extractCalleeName(expr);
    if (!calleeName) continue;

    // Find the containing named function (walk up ancestors)
    let callerNode = call.getParent();
    let callerId: string;
    let confidence = 0.3;
    let reason = "unresolved";

    while (callerNode) {
      if (Node.isFunctionDeclaration(callerNode) || Node.isMethodDeclaration(callerNode)) {
        const fnName = (callerNode as FunctionDeclaration | MethodDeclaration).getName?.();
        if (fnName) {
          const callerFile = np(callerNode.getSourceFile().getFilePath());
          callerId = eid(callerFile, fnName);
          reason = "in_named_function";
          confidence = 0.5;
        }
        break;
      }
      callerNode = callerNode.getParent();
    }
    if (!callerId!) {
      // Fallback: arrow function or top-level
      let arrow = call.getFirstAncestorByKind(SyntaxKind.ArrowFunction);
      if (arrow) {
        const arrowVar = arrow.getParent();
        if (arrowVar && Node.isVariableDeclaration(arrowVar)) {
          callerId = eid(fp, arrowVar.getName());
        } else {
          callerId = eid(fp, `anon_${call.getStartLineNumber()}`);
        }
        reason = "in_arrow";
      } else {
        callerId = eid(fp, `toplevel_${call.getStartLineNumber()}`);
        reason = "top_level";
      }
    }

    // Try to resolve callee via TypeScript's symbol system
    let calleeId: string | undefined;
    if (Node.isIdentifier(expr)) {
      try {
        const defs = expr.getDefinitions();
        if (defs.length > 0) {
          const defNode = defs[0].getDeclarationNode();
          if (defNode) {
            const defFile = np(defNode.getSourceFile().getFilePath());
            calleeId = eid(defFile, calleeName);
            confidence = 0.9;
            reason = "resolved";
          }
        }
      } catch {}
    } else if (Node.isPropertyAccessExpression(expr)) {
      // Method/property calls (obj.method()) resolve through the type checker
      // via the language service's go-to-definition on the property name node.
      try {
        const nameNode = expr.getNameNode();
        const defs = nameNode.getDefinitions();
        if (defs.length > 0) {
          const defNode = defs[0].getDeclarationNode();
          if (defNode) {
            const defFile = np(defNode.getSourceFile().getFilePath());
            calleeId = eid(defFile, expr.getName());
            confidence = 0.8;
            reason = "resolved_method";
          }
        }
      } catch {}
    }

    facts.push({ kind: "calls", callerId, calleeName, calleeId, confidence, reason });
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
const kinds: Record<string, number> = {};
for (const f of unique) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
log("info", `By kind: ${JSON.stringify(kinds)}`);

const decls = unique.filter(f => f.kind === "declaration") as DeclFact[];
const types: Record<string, number> = {};
for (const d of decls) types[d.entityType] = (types[d.entityType] || 0) + 1;
log("info", `Decl by type: ${JSON.stringify(types)}`);

const calls = unique.filter(f => f.kind === "calls") as CallsFact[];
const confs: Record<string, number> = {};
for (const c of calls) {
  const b = Math.round(c.confidence * 10) / 10 + "";
  confs[b] = (confs[b] || 0) + 1;
}
log("info", `Call confidence: ${JSON.stringify(confs)}`);
log("info", `Resolved calls: ${calls.filter(c => c.calleeId).length} of ${calls.length}`);
