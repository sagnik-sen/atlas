import * as fs from "fs";

const F: any[] = JSON.parse(fs.readFileSync("facts.json", "utf-8"));

const decls = F.filter((f: any) => f.kind === "declaration");
const imports = F.filter((f: any) => f.kind === "import");
const reexports = F.filter((f: any) => f.kind === "reexport");
const calls = F.filter((f: any) => f.kind === "calls");
const contains = F.filter((f: any) => f.kind === "contains");
const extends_ = F.filter((f: any) => f.kind === "extends");

// Module-to-entity map
const modEnts = new Map<string, Set<string>>();
for (const c of contains) {
  if (!modEnts.has(c.containerId)) modEnts.set(c.containerId, new Set());
  modEnts.get(c.containerId)!.add(c.entityId);
}

// Entity-to-module.
// `contains` never places a module inside itself, so a module id resolved
// through this map alone comes back undefined — and 30% of call facts are
// attributed to a module, because that is where top-level code lives. Those
// edges were being dropped from every module-level analysis.
const entMod = new Map<string, string>();
for (const c of contains) entMod.set(c.entityId, c.containerId);
for (const d of decls) if (d.entityType === "module") entMod.set(d.entityId, d.entityId);

// Module imports
const modImports = new Map<string, Set<string>>();
// Value imports only. A type-only import creates no call edge by construction,
// so judging it against call evidence is a category error, not a finding —
// this is 24% of Zod's import facts. The importType field has always carried
// the distinction; nothing read it.
const modValueImports = new Map<string, Set<string>>();
for (const imp of imports) {
  if (imp.exportedBy.startsWith("external:")) continue;
  if (!modImports.has(imp.importerFile)) modImports.set(imp.importerFile, new Set());
  modImports.get(imp.importerFile)!.add(imp.exportedBy);
  if (imp.importType.startsWith("type-")) continue;
  if (!modValueImports.has(imp.importerFile)) modValueImports.set(imp.importerFile, new Set());
  modValueImports.get(imp.importerFile)!.add(imp.exportedBy);
}

// A barrel re-exporting from a module imports it to pass it through, not to
// call into it. Counting that as a missing call edge measures the barrel
// pattern, not an accidental dependency.
const passThrough = new Set(reexports.map((r: any) => `${r.barrel}\u0000${r.source}`));

// Imports name the barrel they were written against; resolved calls name the
// file the definition actually lives in. `import * as core from "core/index"`
// followed by `core.$constructor()` yields an import edge to index.ts and a
// call edge to core.ts, which can never match at module level. Expanding an
// import target through its re-export closure is what report.md rec #4 means
// by "trace through to the source declarations".
const reexportEdges = new Map<string, Set<string>>();
for (const r of reexports) {
  if (!reexportEdges.has(r.barrel)) reexportEdges.set(r.barrel, new Set());
  reexportEdges.get(r.barrel)!.add(r.source);
}
const closureCache = new Map<string, Set<string>>();
function reexportClosure(mod: string): Set<string> {
  const hit = closureCache.get(mod);
  if (hit) return hit;
  const out = new Set<string>([mod]);
  closureCache.set(mod, out); // seed before recursing: barrels can cycle
  for (const src of reexportEdges.get(mod) ?? []) {
    if (out.has(src)) continue;
    for (const t of reexportClosure(src)) out.add(t);
  }
  return out;
}

// Module call edges (from resolved calls only).
// entMod yields module ids ("module:v3/types.ts") while modImports is keyed by
// bare file path ("v3/types.ts"). Comparing the two namespaces made every
// modCalls lookup miss, which is why the accidental-dependency heuristic
// flagged 100% of import edges. Normalise to the bare path.
const asFile = (moduleId: string) => moduleId.replace(/^module:/, "");
const instantiates = F.filter((f: any) => f.kind === "instantiates");
const modCalls = new Map<string, Set<string>>();
// An import used only via `new X()` is exercised just as much as one used via
// a call; both are runtime dependencies.
for (const c of [...calls, ...instantiates.map((i: any) => ({ callerId: i.callerId, calleeId: i.classId }))]) {
  if (!c.calleeId) continue;
  const cm = entMod.get(c.callerId);
  const dm = entMod.get(c.calleeId);
  if (cm && dm && cm !== dm) {
    const [sf, df] = [asFile(cm), asFile(dm)];
    if (!modCalls.has(sf)) modCalls.set(sf, new Set());
    modCalls.get(sf)!.add(df);
  }
}

const modules = [...modEnts.keys()];

console.log("=".repeat(70));
console.log("ATLAS PROTOTYPE ANALYSIS REPORT");
console.log("=".repeat(70));

// 1. Module boundaries / coupling
console.log("\n--- 1. Architectural boundaries (import coupling) ---\n");

// Top fan-out by imports
const fanOut = [...modImports.entries()].map(([m, s]) => [m, s.size] as const).sort((a,b) => b[1]-a[1]);
console.log("Highest fan-out (imports other modules):");
for (const [m, s] of fanOut.slice(0, 10)) console.log(`  ${m}: imports ${s} modules`);

// Top fan-in (imported by others)
const fanInMap = new Map<string, number>();
for (const [, ds] of modImports) for (const d of ds) fanInMap.set(d, (fanInMap.get(d)||0)+1);
const fanIn = [...fanInMap.entries()].sort((a,b) => b[1]-a[1]);
console.log("\nHighest fan-in (imported by others):");
for (const [m, s] of fanIn.slice(0, 10)) console.log(`  ${m}: imported by ${s} modules`);

// Mutual imports
let mutual = 0;
for (const [s, ds] of modImports) {
  for (const d of ds) {
    if (modImports.get(d)?.has(s)) mutual++;
  }
}
console.log(`\nBidirectional imports: ${mutual} pairs`);

// 2. Blast radius
console.log("\n--- 2. Blast radius (transitive callers) ---\n");

const targets = decls.filter((d: any) => d.name === "parse" || d.name === "safeParse" || d.name === "_parse");
for (const t of targets.slice(0, 5)) {
  const visited = new Set<string>();
  const stack = [t.entityId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const c of calls) {
      if (c.calleeId === cur && !visited.has(c.callerId)) stack.push(c.callerId);
    }
  }
  visited.delete(t.entityId);
  console.log(`  ${t.name} (${t.file}): ${visited.size} transitive callers`);
  if (visited.size > 0 && visited.size <= 10) {
    for (const id of visited) {
      const d = decls.find((d: any) => d.entityId === id);
      console.log(`    -> ${d?.name ?? id} (${d?.file ?? "?"})`);
    }
  }
}

// 3. Tight coupling
console.log("\n--- 3. Tight coupling (call dependencies) ---\n");

const callFanOut = [...modCalls.entries()].map(([m, s]) => [m, s.size] as const).sort((a,b) => b[1]-a[1]);
console.log("Modules calling most other modules:");
for (const [m, s] of callFanOut.slice(0, 10)) console.log(`  ${m}: calls ${s} modules`);

const callFanInMap = new Map<string, number>();
for (const [, ds] of modCalls) for (const d of ds) callFanInMap.set(d, (callFanInMap.get(d)||0)+1);
const callFanIn = [...callFanInMap.entries()].sort((a,b) => b[1]-a[1]);
console.log("\nModules called by most others:");
for (const [m, s] of callFanIn.slice(0, 10)) console.log(`  ${m}: called by ${s} modules`);

// 4. Accidental dependencies (imported but no call evidence)
console.log("\n--- 4. Accidental dependencies ---\n");
let acc = 0;
const accSamples: string[] = [];
let considered = 0;
for (const [s, ds] of modValueImports) {
  for (const d of ds) {
    if (passThrough.has(`${s}\u0000${d}`)) continue;
    considered++;
    const evidence = modCalls.get(s);
    const satisfied = !!evidence && [...reexportClosure(d)].some(t => evidence.has(t));
    if (!satisfied) {
      acc++;
      if (accSamples.length < 10) accSamples.push(`${s} -> ${d}`);
    }
  }
}
const allEdges = [...modImports.values()].reduce((sum,s)=>sum+s.size,0);
console.log(`Import edges: ${allEdges} total, ${considered} value imports that are not barrel pass-throughs`);
console.log(`Of those, no call evidence: ${acc} (${(100*acc/considered).toFixed(1)}%)`);
for (const s of accSamples) console.log(`  ${s}`);

// 5. Barrel analysis
console.log("\n--- 5. Barrel file analysis ---\n");
const barrelSet = new Set(reexports.map((r: any) => r.barrel));
// Every file now carries a "module" declaration fact, so counting those as
// "own declarations" would make pure barrels unfindable.
const declFiles = new Set(decls.filter((d: any) => d.entityType !== "module").map((d: any) => d.file));
const pureBarrels = [...barrelSet].filter(f => !declFiles.has(f));
console.log(`Barrel files (re-exports): ${barrelSet.size}`);
console.log(`Pure barrels (no own declarations): ${pureBarrels.length}`);
console.log(`  ${pureBarrels.slice(0, 8).map(f => f.split("/").pop()).join(", ")}`);

// 6. Architectural patterns
console.log("\n--- 6. Architectural patterns ---\n");

// Locale pattern detection
const localeFiles = new Set(decls.filter((d: any) => d.file.includes("locales/")).map((d: any) => d.file));
console.log(`Locale files: ${localeFiles.size}`);
console.log(`  Pattern: many files exporting same shape (errorMap / locale functions)`);

// Layer separation: imports flow from v4/core -> v4/classic -> externals
const v4core = modules.filter(m => m.includes("v4/core/"));
const v4classic = modules.filter(m => m.includes("v4/classic/"));
console.log(`\nv4/core modules: ${v4core.length}`);
console.log(`v4/classic modules: ${v4classic.length}`);

// Check if classic imports core
let classicImportsCore = 0;
for (const [s, ds] of modImports) {
  if (s.includes("v4/classic/")) {
    for (const d of ds) {
      if (d.includes("v4/core/")) classicImportsCore++;
    }
  }
}
console.log(`\nv4/classic -> v4/core import edges: ${classicImportsCore}`);

// 7. Failure catalog
console.log("\n--- 7. Failures & limitations ---\n");

const externalImports = imports.filter((i: any) => i.exportedBy.startsWith("external:"));
console.log(`External package imports (unresolved): ${externalImports.length}`);
console.log(`  Used packages: ${new Set(externalImports.map((i: any) => i.exportedBy.replace("external:", ""))).size}`);

const methodCalls = calls.filter((c: any) => c.calleeName?.includes("."));
console.log(`\nObject method calls (obj.method): ${methodCalls.length}, of which unresolved: ${methodCalls.filter((c: any) => !c.calleeId).length}`);

const unresolved = calls.filter((c: any) => !c.calleeId);
const reasons = new Map<string, number>();
for (const c of unresolved) reasons.set(c.reason, (reasons.get(c.reason)||0)+1);
console.log(`\nUnresolved calls by reason:`);
for (const [r, n] of [...reasons.entries()].sort((a,b) => b[1]-a[1])) console.log(`  ${r}: ${n}`);

console.log("\n--- 8. Key metrics ---\n");
console.log(`Modules: ${modules.length}`);
console.log(`Declarations: ${decls.length}`);
console.log(`Import edges: ${[...modImports.values()].reduce((s,x)=>s+x.size,0)}`);
console.log(`Call edges (resolved): ${calls.filter((c:any)=>c.calleeId).length}`);
console.log(`Re-export edges: ${reexports.length}`);
console.log(`Average imports per module: ${([...modImports.values()].reduce((s,x)=>s+x.size,0)/modules.length).toFixed(1)}`);
console.log(`Average calls per module: ${(calls.filter((c:any)=>c.calleeId).length/modules.length).toFixed(1)}`);

console.log("\nDone.");
