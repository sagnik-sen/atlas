// Compare runtime facts (facts.runtime.json) with static facts (facts.json).
// Run: cd prototype && npx tsx trace-analyze.ts
import * as fs from "fs";

const S: any[] = JSON.parse(fs.readFileSync("facts.json", "utf-8"));
const R: any[] = JSON.parse(fs.readFileSync("facts.runtime.json", "utf-8"));
const TOTAL_RUNS = Math.max(...R.map((e) => e.runs ?? 1));
const pct = (a: number, b: number) => `${a}/${b} (${b ? ((100 * a) / b).toFixed(1) : "-"}%)`;

const declared = new Set<string>(S.filter((f) => f.kind === "declaration").map((f) => f.entityId));
const sCalls = S.filter((f) => f.kind === "calls" && f.calleeId);
const sPairs = new Set(sCalls.map((f) => `${f.callerId}\u0000${f.calleeId}`));

// ── join rate ─────────────────────────────────────────────────────────────
const internal = R.filter((e) => e.callerTier !== "external");
const ext = R.length - internal.length;
const both = (e: any) => e.callerResolved && e.calleeResolved;
const exactBoth = (e: any) => e.callerTier === "exact" && e.calleeTier === "exact";
const w = (xs: any[]) => xs.reduce((n, e) => n + e.samples, 0);
console.log(`runtime edges: ${R.length} (${internal.length} zod->zod, ${ext} rooted at the workload driver, outside the corpus)`);
console.log(`\nJOIN to declared static entities (zod->zod edges only):`);
console.log(`  both endpoints resolve to a declared id : ${pct(internal.filter(both).length, internal.length)}   sample-weighted ${pct(w(internal.filter(both)), w(internal))}`);
console.log(`  both endpoints EXACT (function node itself is a declared entity): ${pct(internal.filter(exactBoth).length, internal.length)}`);
const tally = (k: string) => { const t: Record<string, number> = {}; for (const e of R) { const v = e[k]; if (v !== "external") t[v] = (t[v] ?? 0) + 1; } return JSON.stringify(t); };
console.log(`  caller tiers ${tally("callerTier")}`);
console.log(`  callee tiers ${tally("calleeTier")}`);
console.log(`  (exact = frame position is a declared function; enclosing = frame is an anonymous function with no id of its own, attributed to the nearest declared enclosing entity as extract.ts's callSite() does; module = top-level code; line = same-line fallback)`);
const frames = new Map<string, any>();
for (const e of R) { frames.set(e.calleeFrame, e.calleeTier); if (e.callerFrame !== "<workload>") frames.set(e.callerFrame, e.callerTier); }
const ft: Record<string, number> = {}; for (const t of frames.values()) ft[t] = (ft[t] ?? 0) + 1;
console.log(`  distinct frames: ${frames.size} ${JSON.stringify(ft)}`);

// ── novelty ───────────────────────────────────────────────────────────────
const joined = internal.filter(both);
const inStatic = joined.filter((e) => sPairs.has(`${e.callerId}\u0000${e.calleeId}`));
const novel = joined.filter((e) => !sPairs.has(`${e.callerId}\u0000${e.calleeId}`));
console.log(`\nNOVELTY (joined edges): in static facts ${pct(inStatic.length, joined.length)}; NOT in static ${novel.length}`);
console.log(`  of the novel ones, both endpoints exact: ${novel.filter(exactBoth).length}; self-loops: ${novel.filter((e) => e.callerId === e.calleeId).length}; via a native frame: ${novel.filter((e) => e.viaNative).length}`);
// Alias-aware: `const parse = core._parse(Err)` is a variable bound to the closure `_parse.fn`.
// A runtime edge into `_parse.fn` is the static edge into `parse` seen through a different name.
const alias = new Map<string, Set<string>>(); // closure entity -> variable that holds it
for (const f of sCalls) if (f.callerKind === "variable" && declared.has(f.calleeId)) {
  for (const d of declared) if (d.startsWith(f.calleeId + ".") && d.slice(f.calleeId.length + 1).split(".").length === 1) (alias.get(d) ?? alias.set(d, new Set()).get(d)!).add(f.callerId);
}
const viaAlias = novel.filter((e) => [...(alias.get(e.calleeId) ?? [])].some((v) => sPairs.has(`${e.callerId}\u0000${v}`)));
console.log(`  of the novel ones, already in static under the factory-closure alias (callee id differs, same edge): ${viaAlias.length}`);
// Static completeness the other way round: static edges between declared ids seen at runtime.
const rPairs = new Set(joined.map((e) => `${e.callerId}\u0000${e.calleeId}`));
console.log(`  static call pairs also observed at runtime: ${pct([...sPairs].filter((p) => rPairs.has(p)).length, sPairs.size)} (workload exercises a small slice of Zod)`);

// ── closure ───────────────────────────────────────────────────────────────
function rev(extra: any[]) {
  const m = new Map<string, Set<string>>();
  for (const f of [...sCalls, ...extra]) {
    if (!f.calleeId || f.callerId === f.calleeId) continue;
    (m.get(f.calleeId) ?? m.set(f.calleeId, new Set()).get(f.calleeId)!).add(f.callerId);
  }
  return m;
}
function closure(m: Map<string, Set<string>>, seeds: string[]) {
  const seen = new Set<string>(seeds), q = [...seeds];
  while (q.length) for (const c of m.get(q.pop()!) ?? []) if (!seen.has(c)) { seen.add(c); q.push(c); }
  seeds.forEach((s) => seen.delete(s));
  return seen;
}
const mStatic = rev([]);
const mBoth = rev(R.filter((e) => e.callerTier !== "external" && both(e)));
const mExact = rev(R.filter((e) => e.callerTier !== "external" && exactBoth(e)));
// the workload driver is one pseudo-caller, not 70
const mWithDriver = rev(R.filter((e) => e.calleeResolved && (both(e) || e.callerTier === "external")));

const PUBLIC_PARSE = "ts:v4/classic/parse.ts:parse";
// classic/parse.ts:parse is `core._parse(ZodRealError)`: a variable bound to the closure that
// `_parse` returns. At runtime that closure's frame is `_parse.fn`, a different entity.
const factory = sCalls.find((f) => f.callerId === PUBLIC_PARSE && /core\/parse\.ts:_parse$/.test(f.calleeId))?.calleeId;
const aliases = factory ? [...declared].filter((d) => d.startsWith(factory + ".") && d.split(".").length === factory.split(".").length + 1) : [];

const seeds: [string, string[]][] = [
  ["public parse, classic/parse.ts:parse (the report's 1)", [PUBLIC_PARSE]],
  ["  + factory alias (parse := _parse.fn)", [PUBLIC_PARSE, ...aliases]],
  ["ZodType.parse wrapper fn (what z.string().parse IS at runtime)", ["ts:v4/classic/schemas.ts:_zodTypeParseProps.@objectliteral0.parse.fn"]],
  ["_parse.fn (core)", aliases],
  ["$ZodObjectJIT (inst._zod.parse impl, behind _zod.run)", ["ts:v4/core/schemas.ts:$ZodObjectJIT"]],
  ["$ZodString (inst._zod.parse impl, behind _zod.run)", ["ts:v4/core/schemas.ts:$ZodString"]],
  ["$ZodNumber", ["ts:v4/core/schemas.ts:$ZodNumber"]],
  ["_zodTypeParseProps.parse factory (installed via installLazyProps)", ["ts:v4/classic/schemas.ts:_zodTypeParseProps.@objectliteral0.parse"]],
];
console.log(`\nTRANSITIVE CALLERS (distinct entities, seeds excluded): static -> +runtime exact-tier edges -> +runtime all joined edges  [+ workload driver]`);
for (const [label, s] of seeds) {
  const ok = s.filter((x) => declared.has(x));
  if (!ok.length) { console.log(`  ${label}: seed not declared (${s.join(",")})`); continue; }
  const a = closure(mStatic, ok), x = closure(mExact, ok), b = closure(mBoth, ok), c = closure(mWithDriver, ok);
  const added = [...x].filter((y) => !a.has(y));
  console.log(`  ${label}: ${a.size} -> ${x.size} -> ${b.size}  [driver: ${c.size}]${added.length ? "  exact-added: " + added.slice(0, 5).join(", ") + (added.length > 5 ? ", ..." : "") : ""}`);
}

// ── the specific missing hops ─────────────────────────────────────────────
console.log(`\nTHE MISSING HOPS (runtime edges, with static presence):`);
const show = (re: RegExp, lim = 6) => {
  const hits = R.filter((e) => re.test(`${e.callerId} -> ${e.calleeId}`)).sort((a, b) => b.samples - a.samples).slice(0, lim);
  for (const e of hits) console.log(`  ${sPairs.has(`${e.callerId}\u0000${e.calleeId}`) ? "static+" : "NEW    "} ${e.samples.toString().padStart(6)} runs ${e.runs}/${TOTAL_RUNS}  ${e.callerId} -> ${e.calleeId}${e.viaNative ? "  (via native)" : ""}`);
};
console.log(" installLazyProps -> its factory / getter -> installed prop:");
show(/installLazyProps -> .*_zodTypeParseProps$|defineCached.*get -> .*_zodTypeParseProps.*parse$/, 8);
console.log(" ZodType.parse wrapper -> core _parse -> _zod.run -> implementation:");
show(/parse\.fn -> .*(_parse\.fn|\$Zod)|_parse\.fn -> .*(wrapped|\$Zod)|wrapped -> .*\$Zod/, 12);
// The static fact base's own best attempt at the same hop:
const staticFromParseFn = sCalls.filter((f) => /_zodTypeParseProps\.@objectliteral0\.parse\.fn$/.test(f.callerId)).map((f) => f.calleeId);
console.log(` static callees of the wrapper fn: ${JSON.stringify(staticFromParseFn)}`);
const staticRun = sCalls.filter((f) => /core\/parse\.ts:_parse\.fn$/.test(f.callerId) && /_zod|run/.test(f.calleeName));
console.log(` static facts for the _zod.run call in _parse.fn: ${JSON.stringify(staticRun.map((f) => [f.calleeName, f.calleeId, f.reason, f.confidence]))}`);

// ── shortest caller path from an implementation up to the public wrapper ───
function path(m: Map<string, Set<string>>, from: string, to: string) {
  const par = new Map<string, string>([[from, ""]]), q = [from];
  while (q.length) { const x = q.shift()!; if (x === to) break; for (const c of m.get(x) ?? []) if (!par.has(c)) { par.set(c, x); q.push(c); } }
  if (!par.has(to)) return null;
  const out = []; for (let x = to; x; x = par.get(x)!) out.push(x); return out;
}
const PUB = "ts:v4/classic/schemas.ts:_zodTypeParseProps.@objectliteral0.parse.fn";
console.log(`\nCALL PATH (user-facing wrapper -> ... -> implementation):`);
for (const impl of ["ts:v4/core/schemas.ts:$ZodObjectJIT", "ts:v4/core/memoizer.ts:attachMemoizer.@arrowfunction0.wrapped"]) {
  const ps = path(mStatic, impl, PUB), pe = path(mExact, impl, PUB), pb = path(mBoth, impl, PUB);
  const f = (p: string[] | null) => (p ? `${p.length - 1} hops: ${p.join(" -> ")}` : "NO PATH");
  console.log(`  ${impl}\n    static-only        : ${f(ps)}\n    +runtime exact-only: ${f(pe)}\n    +runtime all joined: ${f(pb)}`);
}
const hist: Record<number, number> = {}; for (const e of R) hist[e.runs ?? 1] = (hist[e.runs ?? 1] ?? 0) + 1;
console.log(`\nSAMPLING RECALL: ${TOTAL_RUNS} merged processes; edges by number of runs that saw them ${JSON.stringify(hist)}`);
