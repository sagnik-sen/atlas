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

// Entity-to-module
const entMod = new Map<string, string>();
for (const c of contains) entMod.set(c.entityId, c.containerId);

// Module imports
const modImports = new Map<string, Set<string>>();
for (const imp of imports) {
  if (imp.exportedBy.startsWith("external:")) continue;
  if (!modImports.has(imp.importerFile)) modImports.set(imp.importerFile, new Set());
  modImports.get(imp.importerFile)!.add(imp.exportedBy);
}

// Module call edges (from resolved calls only)
const modCalls = new Map<string, Set<string>>();
for (const c of calls) {
  if (!c.calleeId) continue;
  const cm = entMod.get(c.callerId);
  const dm = entMod.get(c.calleeId);
  if (cm && dm && cm !== dm) {
    if (!modCalls.has(cm)) modCalls.set(cm, new Set());
    modCalls.get(cm)!.add(dm);
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
for (const [s, ds] of modImports) {
  for (const d of ds) {
    if (!modCalls.get(s)?.has(d)) {
      acc++;
      if (accSamples.length < 10) accSamples.push(`${s} -> ${d}`);
    }
  }
}
console.log(`Import edges with no call evidence: ${acc} of ${[...modImports.values()].reduce((sum,s)=>sum+s.size,0)}`);
for (const s of accSamples) console.log(`  ${s}`);

// 5. Barrel analysis
console.log("\n--- 5. Barrel file analysis ---\n");
const barrelSet = new Set(reexports.map((r: any) => r.barrel));
const declFiles = new Set(decls.map((d: any) => d.file));
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
console.log(`\nObject method calls (obj.method -> unresolved): ${methodCalls.length}`);

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
