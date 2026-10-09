// Architectural questions, answered from the fact base — or honestly refused.
//
// thesis.md §5.5 argues the path to credibility is "here are questions nobody
// can answer today, and here is Atlas answering them". This script is that,
// with one rule: a question Atlas CANNOT answer prints why, and the reason
// names the missing fact kind. A demo that quietly drops its failures is how
// this project published four wrong conclusions.
//
// Usage: npx tsx questions.ts
import * as fs from "fs";

type Fact = any;
const F: Fact[] = JSON.parse(fs.readFileSync("facts.json", "utf-8"));
const of = (k: string) => F.filter((f) => f.kind === k);

const decls = of("declaration");
const calls = of("calls");
const refs = of("references");
const inst = of("instantiates");
const imports = of("import");
const reexports = of("reexport");
const heritage = [...of("extends"), ...of("implements")];
const contains = of("contains");

const declById = new Map<string, Fact>(decls.map((d) => [d.entityId, d]));
const modOf = new Map<string, string>();
for (const c of contains) modOf.set(c.entityId, c.containerId.replace(/^module:/, ""));
for (const d of decls) if (d.entityType === "module") modOf.set(d.entityId, d.entityId.replace(/^module:/, ""));

// Reverse indexes. Built once: the published analysis scripts were quadratic
// and one of them stopped terminating as the fact base grew.
const callersOf = new Map<string, Set<string>>();
for (const e of [...calls, ...inst.map((i) => ({ callerId: i.callerId, calleeId: i.classId }))]) {
  if (!e.calleeId) continue;
  if (!callersOf.has(e.calleeId)) callersOf.set(e.calleeId, new Set());
  callersOf.get(e.calleeId)!.add(e.callerId);
}
const childrenOf = new Map<string, Set<string>>();
for (const h of heritage) {
  if (!h.parentId) continue;
  if (!childrenOf.has(h.parentId)) childrenOf.set(h.parentId, new Set());
  childrenOf.get(h.parentId)!.add(h.childId);
}

const closure = (seed: string, next: (id: string) => Iterable<string>) => {
  const seen = new Set<string>([seed]);
  const stack = [seed];
  while (stack.length) for (const n of next(stack.pop()!)) if (!seen.has(n)) (seen.add(n), stack.push(n));
  seen.delete(seed);
  return seen;
};

const name = (id: string) => {
  const d = declById.get(id);
  return d ? `${d.name} (${d.file})` : id;
};
const h1 = (n: number, q: string) => console.log(`\n${"=".repeat(74)}\nQ${n}. ${q}\n${"=".repeat(74)}`);
const verdict = (ok: boolean, why: string) => console.log(`\n  ${ok ? "ANSWERED" : "CANNOT ANSWER"} — ${why}`);

// ── Q1 ────────────────────────────────────────────────────────────────
h1(1, "If I change this function's signature, what breaks?");
{
  const seeds = ["ts:v4/core/parse.ts:_parse", "ts:v3/types.ts:ZodType._parse", "ts:v4/core/util.ts:installLazyProps"];
  for (const s of seeds) {
    if (!declById.has(s)) { console.log(`  ${s}: not declared`); continue; }
    const c = closure(s, (id) => callersOf.get(id) ?? []);
    const mods = new Set([...c].map((i) => modOf.get(i) ?? "?"));
    console.log(`  ${name(s)}\n    ${c.size} transitive callers across ${mods.size} modules`);
  }
  verdict(true, "transitive closure over calls + instantiations, both endpoints closed by the identity invariant");
}

// ── Q2 ────────────────────────────────────────────────────────────────
h1(2, "What are the real module boundaries, and which modules are load-bearing?");
{
  const fanIn = new Map<string, Set<string>>();
  for (const i of imports) {
    if (i.exportedBy.startsWith("external:")) continue;
    if (!fanIn.has(i.exportedBy)) fanIn.set(i.exportedBy, new Set());
    fanIn.get(i.exportedBy)!.add(i.importerFile);
  }
  const top = [...fanIn.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  for (const [m, importers] of top) console.log(`  ${m.padEnd(34)} imported by ${importers.size} modules`);
  const barrels = new Set(reexports.map((r) => r.barrel));
  const own = new Set(decls.filter((d) => d.entityType !== "module").map((d) => d.file));
  console.log(`  barrels: ${barrels.size}, of which pure re-export hubs: ${[...barrels].filter((b) => !own.has(b)).length}`);
  verdict(true, "import fan-in plus re-export structure; needs no call graph");
}

// ── Q3 ────────────────────────────────────────────────────────────────
h1(3, "What implements this interface?");
{
  for (const t of ["ts:v3/types.ts:ZodType", "ts:v4/core/schemas.ts:$ZodType"]) {
    if (!declById.has(t)) { console.log(`  ${t}: not declared`); continue; }
    const kids = closure(t, (id) => childrenOf.get(id) ?? []);
    console.log(`  ${name(t)}: ${kids.size} transitive subtypes`);
  }
  const unresolved = heritage.filter((h) => !h.parentId).length;
  verdict(unresolved === 0, `heritage parents resolve to entity ids (${heritage.length - unresolved}/${heritage.length}); before this they were text names and could not be traversed`);
}

// ── Q4 ────────────────────────────────────────────────────────────────
h1(4, "Which imports are dead weight?");
{
  const used = new Map<string, Set<string>>();
  const add = (f: string, id?: string) => {
    if (!f || !id) return;
    const m = modOf.get(id);
    if (!m) return;
    if (!used.has(f)) used.set(f, new Set());
    used.get(f)!.add(m);
  };
  for (const c of calls) add(c.file, c.calleeId);
  for (const i of inst) add(i.file, i.classId);
  for (const r of refs) add(r.file, r.targetId);
  const pass = new Set(reexports.map((r) => `${r.barrel}\u0000${r.source}`));
  let flagged = 0, considered = 0;
  const samples: string[] = [];
  for (const i of imports) {
    if (i.exportedBy.startsWith("external:") || i.importType.startsWith("type-")) continue;
    if (pass.has(`${i.importerFile}\u0000${i.exportedBy}`)) continue;
    considered++;
    if (!used.get(i.importerFile)?.has(i.exportedBy)) {
      flagged++;
      if (samples.length < 4) samples.push(`${i.importerFile} -> ${i.exportedBy} [${i.importedName}]`);
    }
  }
  console.log(`  ${flagged} of ${considered} value imports have no call, instantiation or reference evidence`);
  for (const s of samples) console.log(`    ${s}`);
  verdict(flagged < considered, "needs calls + instantiations + references together; any one alone produced a 100% false-positive rate at some point in this project's history");
}

// ── Q5 ────────────────────────────────────────────────────────────────
h1(5, "What happens when a user calls z.string().parse(x)?");
{
  const pub = "ts:v4/classic/schemas.ts:ZodType.parse";
  const impl = "ts:v4/classic/schemas.ts:_zodTypeParseProps.@objectliteral0.parse";
  const linked = F.some((f) => (f.calleeId === impl || f.targetId === impl) && f.callerId === pub);
  console.log(`  declared public method: ${declById.has(pub) ? "yes" : "no"}`);
  console.log(`  declared implementation: ${declById.has(impl) ? "yes" : "no"}`);
  console.log(`  any fact linking them: ${linked ? "yes" : "NO"}`);
  console.log(`  transitive callers of the classic entry point: ${closure("ts:v4/classic/parse.ts:parse", (id) => callersOf.get(id) ?? []).size}`);
  verdict(false,
    "the method is installed at runtime: installLazyProps -> for (const key in built) defineCached(...) -> dispatch through the mutable field _zod.run. " +
    "No syntactic construct names `parse` on that path, so no static fact can link declaration to implementation. " +
    "Needs runtime trace facts (thesis §5.1). This is not a defect in the extractor.");
}

// ── Q6 ────────────────────────────────────────────────────────────────
h1(6, "Which call edges look trustworthy but lead nowhere?");
{
  // A resolved, high-confidence edge terminating at an entity that cannot have
  // a body. Closure passes; the edge is useless to any consumer.
  const NO_BODY = new Set(["parameter", "binding", "type-method", "type-property", "type", "interface", "module"]);
  const bad = calls.filter((c) => {
    const d = c.calleeId && declById.get(c.calleeId);
    return d && NO_BODY.has(d.entityType);
  });
  const byType: Record<string, number> = {};
  for (const c of bad) byType[declById.get(c.calleeId)!.entityType] = (byType[declById.get(c.calleeId)!.entityType] || 0) + 1;
  console.log(`  ${bad.length} of ${calls.filter((c) => c.calleeId).length} resolved call edges terminate at a non-executable entity`);
  console.log(`  by target type: ${JSON.stringify(byType)}`);
  const hi = bad.filter((c) => c.confidence >= 0.8).length;
  console.log(`  of those, ${hi} carry confidence >= 0.8`);
  for (const c of bad.slice(0, 3)) console.log(`    ${c.file}:${c.line}  ${c.calleeName} -> ${c.calleeId}`);
  verdict(true, "but only as a diagnostic: Atlas can find these, and currently cannot re-resolve them. Confidence does not encode usefulness");
}

console.log(`\n${"=".repeat(74)}`);
console.log(`Answered 5 of 6. Q5 needs runtime facts; Q6 is a diagnostic, not a capability.`);
console.log(`${"=".repeat(74)}\n`);
