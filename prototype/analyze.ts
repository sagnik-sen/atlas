import * as fs from "fs";
import * as path from "path";

type Fact = any;

const facts: Fact[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, "facts.json"), "utf-8"));

const byKind = (kind: string) => facts.filter((f: Fact) => f.kind === kind);

const decls = byKind("declaration");
const imports = byKind("import");
const reexports = byKind("reexport");
const calls = byKind("calls");
const contains = byKind("contains");
const extends_ = byKind("extends");
const implements_ = byKind("implements");

const log = (...args: any[]) => console.log(...args);
const sep = () => log("\n" + "=".repeat(70) + "\n");

// ─── Utility ──────────────────────────────────────────────────────────

/** Module -> list of entities it contains */
const modEntities = new Map<string, Set<string>>();
for (const c of contains) modEntities.set(c.containerId, (modEntities.get(c.containerId) || new Set()).add(c.entityId));

/** Entity (function/class) -> its module */
// Module ids map to themselves: `contains` never places a module inside
// itself, so module-attributed calls (top-level code, 30% of call facts)
// would otherwise drop out of every module-level rollup.
const entityMod = new Map<string, string>();
for (const c of contains) entityMod.set(c.entityId, c.containerId);
for (const d of decls) if (d.entityType === "module") entityMod.set(d.entityId, d.entityId);

/** File -> module id */
// entityMod is already the index this needs; the original did a linear
// contains.find() per declaration, which is ~95M comparisons at the current
// fact-base size and does not terminate in reasonable time.
const fileMod = new Map<string, string>();
for (const d of decls) {
  const m = entityMod.get(d.entityId);
  if (m) fileMod.set(d.file, m);
}

/** Module -> set of imported modules */
const modImports = new Map<string, Set<string>>();
for (const imp of imports) {
  if (imp.exportedBy.startsWith("external:")) continue;
  const src = fileMod.get(imp.importerFile);
  if (!src) continue;
  // resolve reexport chain: if file is a barrel, find actual source
  const barrel = reexports.find((r: Fact) => r.barrel === imp.exportedBy && (!r.reexportedName || r.reexportedName === imp.importedName));
  const targetFile = barrel ? barrel.source : imp.exportedBy;
  const dst = fileMod.get(targetFile);
  if (dst && dst !== src) {
    if (!modImports.has(src)) modImports.set(src, new Set());
    modImports.get(src)!.add(dst);
  }
}

/** Entity -> set of called entities */
const entityCalls = new Map<string, Set<string>>();
for (const c of calls) {
  if (c.calleeId) {
    const src = c.callerId;
    if (!entityCalls.has(src)) entityCalls.set(src, new Set());
    entityCalls.get(src)!.add(c.calleeId);
  }
}

/** Module -> set of modules it calls into */
const modCalls = new Map<string, Set<string>>();
for (const c of calls) {
  if (!c.calleeId) continue;
  const callerMod = entityMod.get(c.callerId);
  const calleeMod = entityMod.get(c.calleeId);
  if (callerMod && calleeMod && callerMod !== calleeMod) {
    if (!modCalls.has(callerMod)) modCalls.set(callerMod, new Set());
    modCalls.get(callerMod)!.add(calleeMod);
  }
}

// ─── Module population ────────────────────────────────────────────────

const modules = new Set<string>();
for (const c of contains) modules.add(c.containerId);
const modList = [...modules];

// ─── 1: What are the actual architectural boundaries? ─────────────────

sep();
log("1. ARCHITECTURAL BOUNDARIES (import-based coupling)");

// Build a coupling matrix: how strongly does each module depend on each other?
// Weighted by number of imports.
const coupling = new Map<string, Map<string, number>>();
for (const [src, dsts] of modImports) {
  for (const dst of dsts) {
    if (!coupling.has(src)) coupling.set(src, new Map());
    coupling.get(src)!.set(dst, (coupling.get(src)!.get(dst) || 0) + 1);
  }
}

// Find pairs with STRONG coupling (multiple imports)
const strongCoupling: [string, string, number][] = [];
for (const [src, dsts] of coupling) {
  for (const [dst, count] of dsts) {
    if (count >= 3) strongCoupling.push([src, dst, count]);
  }
}
strongCoupling.sort((a, b) => b[2] - a[2]);

log(`\nTop strongly coupled module pairs (>=3 imports):`);
for (const [src, dst, count] of strongCoupling.slice(0, 15)) {
  log(`  ${src} -> ${dst}  (${count} imports)`);
}

// Clusters: modules that all import the same thing
log(`\nModules importing v4/core/schemas:`);
const schemasImporters = [...modImports.entries()]
  .filter(([, dsts]) => [...dsts].some(d => d.includes("v4_core_schemas")))
  .map(([src]) => src);
log(`  ${schemasImporters.length} modules: ${schemasImporters.map(m => m.split('/').pop()).join(", ")}`);

// Find modules that form strongly connected components (mutual imports)
log(`\nMutual (bidirectional) imports:`);
let mutualCount = 0;
for (const [src, dsts] of modImports) {
  for (const dst of dsts) {
    const rev = modImports.get(dst);
    if (rev?.has(src)) {
      mutualCount++;
      if (mutualCount <= 10) log(`  ${src} <-> ${dst}`);
    }
  }
}
log(`  ... ${mutualCount} total bidirectional pairs`);

// ─── 2: Blast radius of changing a function ───────────────────────────

sep();
log("2. BLAST RADIUS (transitive callers)");

// Pick a function with known importance
const targetFns = decls.filter((d: Fact) =>
  d.entityType === "function" &&
  (d.name === "parse" || d.name === "safeParse" || d.name === "_parse" || d.name === "_def")
);

// Reverse call index. The walk below used to rescan every call fact per
// visited node, and look each one up with a linear decls.find — tolerable at
// 735 closed edges, quadratic at 5,707. Build both indexes once.
const callersOf = new Map<string, string[]>();
for (const c of calls) {
  if (!c.calleeId) continue;
  if (!callersOf.has(c.calleeId)) callersOf.set(c.calleeId, []);
  callersOf.get(c.calleeId)!.push(c.callerId);
}
const declById = new Map(decls.map((d: Fact) => [d.entityId, d]));

for (const tf of targetFns.slice(0, 3)) {
  log(`\nTransitive callers of ${tf.name} in ${tf.file}:`);
  const visited = new Set<string>();
  const stack: string[] = [tf.entityId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const caller of callersOf.get(current) ?? []) {
      if (!visited.has(caller)) stack.push(caller);
    }
  }
  visited.delete(tf.entityId);
  if (visited.size === 0) {
    log(`  No callers found (unresolved call targets)`);
  } else {
    log(`  ${visited.size} transitive callers`);
    // Group by file
    const byFile = new Map<string, string[]>();
    for (const id of visited) {
      const d = declById.get(id);
      if (d) {
        if (!byFile.has(d.file)) byFile.set(d.file, []);
        byFile.get(d.file)!.push(d.name);
      }
    }
    for (const [file, names] of [...byFile.entries()].slice(0, 10)) {
      log(`    ${file}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? " +" + (names.length-5) + " more" : ""}`);
    }
    if (byFile.size > 10) log(`    ... and ${byFile.size - 10} more files`);
  }
}

// ─── 3: Tightly coupled modules ────────────────────────────────────────

sep();
log("3. TIGHTLY COUPLED MODULES (call dependency)");

// Modules that call into many other modules = high fan-out
const fanOut = [...modCalls.entries()].map(([mod, callees]) => [mod, callees.size] as const);
fanOut.sort((a, b) => b[1] - a[1]);
log(`\nHighest fan-out (modules calling into most other modules):`);
for (const [mod, count] of fanOut.slice(0, 10)) {
  log(`  ${mod}: calls into ${count} other modules`);
}

// In-degree: modules called by many others
const fanIn = new Map<string, number>();
for (const [, callees] of modCalls) {
  for (const callee of callees) {
    fanIn.set(callee, (fanIn.get(callee) || 0) + 1);
  }
}
const fanInSorted = [...fanIn.entries()].sort((a, b) => b[1] - a[1]);
log(`\nHighest fan-in (modules called by most other modules):`);
for (const [mod, count] of fanInSorted.slice(0, 10)) {
  log(`  ${mod}: called by ${count} modules`);
}

// ─── 4: Accidental dependencies ────────────────────────────────────────

sep();
log("4. ACCIDENTAL DEPENDENCIES");

// A dependency is "accidental" if:
// - Module A imports Module B
// - But no entity in A actually calls or references any entity from B

// entity -> names it extends or implements
const heritageParents = new Map<string, string[]>();
for (const ex of [...extends_, ...implements_]) {
  if (!heritageParents.has(ex.childId)) heritageParents.set(ex.childId, []);
  heritageParents.get(ex.childId)!.push(ex.parentName);
}
// declared name -> modules declaring it
const modulesDeclaringName = new Map<string, Set<string>>();
for (const d of decls) {
  const m = entityMod.get(d.entityId);
  if (!m) continue;
  if (!modulesDeclaringName.has(d.name)) modulesDeclaringName.set(d.name, new Set());
  modulesDeclaringName.get(d.name)!.add(m);
}

log(`\nImports with no call evidence:`);
let accidentalCount = 0;
for (const [src, dsts] of modImports) {
  for (const dst of dsts) {
    const callsFromSrc = modCalls.get(src);
    if (!callsFromSrc?.has(dst)) {
      // Was: for each flagged edge, for each entity in src, for each heritage
      // fact, a linear decls.find. Four nested scans over a fact base this size
      // do not terminate. Both lookups are precomputed above.
      const usedThroughExtends = [...modEntities.get(src) || []].some(eid =>
        (heritageParents.get(eid) || []).some(p => modulesDeclaringName.get(p)?.has(dst)));

      if (!usedThroughExtends) {
        accidentalCount++;
        if (accidentalCount <= 10) log(`  ${src} imports ${dst} — no call evidence`);
      }
    }
  }
}
log(`  ... ${accidentalCount} total potential accidental dependencies`);

// ─── 5: Unused imports ─────────────────────────────────────────────────

sep();
log("5. UNUSED IMPORTS (named imports never referenced in calls/extends)");

// For each named import, check if anything in the file references that name
const importedNames = new Map<string, Set<string>>(); // file -> { names }
for (const imp of imports) {
  // Type-only imports are excluded: a `import type` binding produces no call,
  // instantiation or heritage fact by construction, so judging it against
  // usage evidence is a category error rather than a finding. Same fix as
  // analyze2.ts's accidental-dependency heuristic.
  if (imp.importType === "default" || imp.importType === "named") {
    if (!importedNames.has(imp.importerFile)) importedNames.set(imp.importerFile, new Set());
    importedNames.get(imp.importerFile)!.add(imp.importedName);
  }
}

// Usage evidence per file, indexed once. The original rebuilt both lists per
// file with a nested decls.find, and counted only `calls` and `extends` as
// evidence — so an import used solely via `new X()` or `implements X` was
// reported as unused. `calls` and `instantiates` facts carry `file` directly,
// so the caller lookup was never needed.
const instantiates_ = byKind("instantiates");
const usedNamesByFile = new Map<string, Set<string>>();
const addUse = (file: string, name: string | undefined) => {
  if (!file || !name) return;
  if (!usedNamesByFile.has(file)) usedNamesByFile.set(file, new Set());
  const set = usedNamesByFile.get(file)!;
  set.add(name);
  // `util.assertNever` is evidence for the import named `util`.
  const root = name.split(".")[0];
  if (root) set.add(root);
};
for (const c of calls) addUse(c.file, c.calleeName);
for (const i of instantiates_) addUse(i.file, i.className);
const declFile = new Map(decls.map((d: Fact) => [d.entityId, d.file]));
for (const ex of [...extends_, ...implements_]) {
  addUse(declFile.get(ex.childId)!, ex.parentName);
}

let unusedCount = 0;
for (const [file, names] of importedNames) {
  const used = usedNamesByFile.get(file) ?? new Set<string>();
  for (const name of names) {
    if (!used.has(name)) {
      unusedCount++;
      if (unusedCount <= 15) log(`  ${file}: '${name}' — imported but no usage detected`);
    }
  }
}
log(`  ... ${unusedCount} total potential unused imports`);

// ─── 6: Surprising architecture discoveries ───────────────────────────

sep();
log("6. ARCHITECTURAL PATTERNS");

// Barrel file density
const barrelFiles = new Set<string>();
for (const r of reexports) barrelFiles.add(r.barrel);
log(`\nBarrel/re-export files: ${barrelFiles.size}`);

// Files that are only barrels (no actual declarations, just re-exports)
const filesWithDecls = new Set(decls.map((d: Fact) => d.file));
const pureBarrels = [...barrelFiles].filter(f => !filesWithDecls.has(f));
log(`Pure barrel files (re-exports only): ${pureBarrels.length}`);
if (pureBarrels.length > 0) {
  log(`  ${pureBarrels.slice(0, 5).map(f => f.split('/').pop()).join(", ")}`);
}

// Locale pattern: many files that all export the same shape
const localeDecls = decls.filter((d: Fact) => d.file.includes("locales/") && d.file !== "src/v4/locales/index.ts");
log(`\nLocale files: ${new Set(localeDecls.map((d: Fact) => d.file)).size}`);
const localeExportedFns = localeDecls.filter((d: Fact) => d.exported && d.entityType === "function");
log(`Locale files with exported functions (pattern match): ${new Set(localeExportedFns.map((d: Fact) => d.file)).size}`);

// Test coupling: do test files test the right modules?
// (We excluded tests, but check what files exist)
log(`\nSource files analyzed: ${filesWithDecls.size}`);

// ─── 7: Dependency density ─────────────────────────────────────────────

sep();
log("7. DEPENDENCY DENSITY");

const modCount = modules.size;
const importEdgeCount = [...modImports.values()].reduce((sum, s) => sum + s.size, 0);
const callEdgeCount = [...modCalls.values()].reduce((sum, s) => sum + s.size, 0);

log(`Modules: ${modCount}`);
log(`Import edges (module -> module): ${importEdgeCount}`);
log(`Call edges (module -> module): ${callEdgeCount}`);
log(`Average imports per module: ${(importEdgeCount / modCount).toFixed(1)}`);
log(`Average calls per module: ${(callEdgeCount / modCount).toFixed(1)}`);

// Disconnected modules
const connected = new Set<string>();
for (const [src, dsts] of modImports) {
  connected.add(src);
  for (const d of dsts) connected.add(d);
}
const isolated = [...modules].filter(m => !connected.has(m));
log(`Isolated modules (no import edges): ${isolated.length}`);
if (isolated.length > 0) log(`  ${isolated.slice(0, 5).map(m => m.split('/').pop()).join(", ")}`);

// ─── 8: Confusion analysis ─────────────────────────────────────────────

sep();
log("8. CONFUSION ANALYSIS");

// Unsure calls (confidence < 0.7)
const unsure = calls.filter((c: Fact) => c.confidence < 0.7);
log(`Calls with low confidence (< 0.7): ${unsure.length} of ${calls.length} (${(unsure.length/calls.length*100).toFixed(1)}%)`);

// By reason
const byReason = new Map<string, number>();
for (const c of calls) {
  byReason.set(c.reason, (byReason.get(c.reason) || 0) + 1);
}
log(`Call resolution reasons:`);
for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
  log(`  ${reason}: ${count}`);
}

// Report failures
sep();
log("9. FAILURES / LIMITATIONS");

log(`\n- Could not resolve: ${imports.filter((i: Fact) => i.exportedBy.startsWith("external:")).length} external package imports`);
// These two were hardcoded literals frozen from an earlier run, printed as if
// computed. They read as findings and were wrong by an order of magnitude.
log(`- ${decls.filter((d: Fact) => d.entityType === "unknown").length} entities classified as "unknown" type (could not determine declaration kind)`);
log(`- ${calls.filter((c: Fact) => !c.calleeId).length} call expressions could not be resolved at all`);

log("\nDone.");
