// Runtime-trace spike: run a workload against the real Zod source under V8's
// sampling CPU profiler (in-process inspector), turn the call tree into
// caller->callee edges, map frames back to Atlas entity ids, and emit them as
// `calls` facts (confidence 0.95, reason "runtime") to facts.runtime.json.
//
// Run: cd prototype && npx tsx trace.ts
import * as inspector from "node:inspector";
import * as v8 from "node:v8";
import { SourceMap } from "node:module";
import * as fs from "fs";
import * as path from "path";
import { Project, Node, SyntaxKind } from "ts-morph";
import { setRoot, idOfNode, callSite, typeOfNode, mid } from "./ids";

// Optimizing tiers inline callees and elide their frames; keep the interpreter so every call shows up.
if (process.env.TRACE_OPT !== "1") v8.setFlagsFromString("--no-opt");
const ROOT = fs.realpathSync(path.resolve(__dirname, "zod-repo/packages/zod/src"));
const ENTRY = path.join(ROOT, "v4/classic/external.ts");
const TSCONFIG = path.resolve(__dirname, "zod-repo/packages/zod/tsconfig.json");
const ITERS = Number(process.env.TRACE_ITERS ?? 20000);
const INTERVAL_US = Number(process.env.TRACE_INTERVAL_US ?? 25);
const OUT = process.env.TRACE_OUT ?? path.resolve(__dirname, "facts.runtime.json");

// ── 1. profile ────────────────────────────────────────────────────────────
const session = new inspector.Session();
session.connect();
const post = (m: string, p?: any) =>
  new Promise<any>((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));

const scripts = new Map<string, { url: string; map?: string }>();
session.on("Debugger.scriptParsed", (m: any) => {
  const p = m.params;
  if (p.url && p.url.includes("packages/zod/src")) scripts.set(p.scriptId, { url: p.url, map: p.sourceMapURL });
});

async function workload(z: any) {
  const shared = z.object({ name: z.string().min(2), age: z.number().int(), tags: z.array(z.string()).optional() });
  const un = z.union([z.string(), z.number()]);
  for (let i = 0; i < ITERS; i++) {
    z.string().parse("x");
    z.object({ a: z.string() }).parse({ a: "y" });
    shared.parse({ name: "bob", age: 3, tags: ["a", "b"] });
    shared.safeParse({ name: "b", age: 3.5 });                      // failing safeParse
    try { z.number().parse("nope"); } catch { /* failing parse throws */ }
    un.parse(i % 2 ? "s" : 4);
    z.string().transform((s: string) => s.length).parse("abc");
    z.string().refine((s: string) => s.length > 1).safeParse("a");
    if (i % 50 === 0) await z.string().parseAsync("async");
  }
}

async function profile() {
  await post("Debugger.enable");
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: INTERVAL_US });
  await post("Profiler.start");
  const z = await import(ENTRY);          // module-init is traced too
  await workload(z);
  const { profile } = await post("Profiler.stop");
  return profile;
}

// ── 2. frames -> original (file,line,col) via the source map tsx embeds ──────
const maps = new Map<string, SourceMap | null>();
function mapOf(scriptId: string): SourceMap | null {
  if (maps.has(scriptId)) return maps.get(scriptId)!;
  let sm: SourceMap | null = null;
  const m = scripts.get(scriptId)?.map;
  const b = m?.match(/^data:application\/json;(?:charset=[^;]+;)?base64,(.*)$/);
  if (b) { try { sm = new SourceMap(JSON.parse(Buffer.from(b[1], "base64").toString())); } catch { /* none */ } }
  maps.set(scriptId, sm);
  return sm;
}

interface Frame { file: string; line: number; col: number; fn: string; } // file relative to ROOT, 1-based line, 0-based col
function frameOf(cf: any): Frame | null {
  let f = cf.url as string;
  if (f.startsWith("file://")) f = decodeURIComponent(new URL(f).pathname);
  if (!f.startsWith(ROOT + "/") || cf.functionName === "__name") return null;   // builtin, tsx helper, node_modules, workload
  const sm = mapOf(cf.scriptId);
  let line = cf.lineNumber, col = cf.columnNumber;
  if (sm) {
    const e: any = sm.findEntry(cf.lineNumber, cf.columnNumber);
    if (e && e.originalLine !== undefined) { line = e.originalLine; col = e.originalColumn; }
  }
  return { file: path.relative(ROOT, f), line: line + 1, col, fn: cf.functionName };
}

// ── 3. static index: function start position -> id ────────────────────────
const facts: any[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, "facts.json"), "utf-8"));
const declared = new Set<string>(facts.filter((f) => f.kind === "declaration").map((f) => f.entityId));

interface Fn { id: string | null; encl: string; start: number; nameStart: number; line: number; kind: string; name: string; }
const byFile = new Map<string, Fn[]>();
function indexStatic() {
  setRoot(path.resolve(__dirname, "zod-repo/packages/zod/src")); // same (un-realpathed) root extract.ts uses
  const project = new Project({ tsConfigFilePath: TSCONFIG });
  const K = [SyntaxKind.FunctionDeclaration, SyntaxKind.MethodDeclaration, SyntaxKind.Constructor,
    SyntaxKind.GetAccessor, SyntaxKind.SetAccessor, SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression,
    SyntaxKind.ClassDeclaration, SyntaxKind.ClassExpression];
  for (const sf of project.getSourceFiles()) {
    const fp = fs.realpathSync(sf.getFilePath());
    if (!fp.startsWith(ROOT + "/")) continue;
    const list: Fn[] = [];
    for (const k of K) for (const n of sf.getDescendantsOfKind(k) as any[]) {
      const id = idOfNode(n);
      const nm = n.getNameNode?.();
      list.push({
        id, encl: callSite(n, mid(sf.getFilePath())).callerId, start: n.getStart(),
        nameStart: nm ? nm.getStart() : n.getStart(), line: n.getStartLineNumber(),
        kind: typeOfNode(n), name: (n.getName?.() as string) ?? "",
      });
    }
    byFile.set(path.relative(ROOT, fp), list);
    (byFile as any).sf ??= new Map(); (byFile as any).sf.set(path.relative(ROOT, fp), sf);
  }
}

type Tier = "exact" | "enclosing" | "line" | "module" | "none";
interface Res { id: string | null; tier: Tier; callerKind: string; }
function resolve(f: Frame): Res {
  const list = byFile.get(f.file) ?? [];
  const sf: any = (byFile as any).sf.get(f.file);
  if (f.line === 1 && f.col === 0 && !f.fn) return { id: `module:${f.file.replace(/[^a-zA-Z0-9_$/@.-]/g, "_")}`, tier: "module", callerKind: "module" };
  let pos = -1; try { pos = sf ? sf.compilerNode.getPositionOfLineAndCharacter(f.line - 1, f.col) : -1; } catch { console.log("BADPOS", JSON.stringify(f)); }
  const at = list.filter((n) => (pos - n.start === 0 || pos - n.start === 1 || n.nameStart === pos)).sort((a, b) => Math.abs(a.start - pos) - Math.abs(b.start - pos)); /* V8+esbuild point an arrow one token past its start */
  const pick = (c: Fn[], tier: Tier): Res | null => {
    for (const n of c) {
      if (n.id && declared.has(n.id)) return { id: n.id, tier, callerKind: n.kind };
    }
    for (const n of c) if (declared.has(n.encl)) return { id: n.encl, tier: "enclosing", callerKind: "enclosing" };
    return null;
  };
  return pick(at, "exact")
    ?? pick(list.filter((n) => n.line === f.line && (n.name === f.fn || !n.name || !f.fn)), "line")
    ?? { id: null, tier: "none", callerKind: "unknown" };
}

// ── 4. call tree -> edges ──────────────────────────────────────────────────
interface Edge { a: Frame | null; b: Frame; via: boolean; n: number; }
function edgesOf(profile: any): Map<string, Edge> {
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  const hit = new Map<number, number>();
  for (const s of profile.samples) hit.set(s, (hit.get(s) ?? 0) + 1);
  const out = new Map<string, Edge>();
  // total[n] = samples in the subtree, so an edge's weight is its callee's inclusive time.
  const total = new Map<number, number>();
  const sum = (id: number): number => {
    const n = nodes.get(id);
    let t = hit.get(id) ?? 0;
    for (const c of n.children ?? []) t += sum(c);
    total.set(id, t);
    return t;
  };
  sum(profile.nodes[0].id);
  const walk = (id: number, last: Frame | null, via: boolean) => {
    const n = nodes.get(id);
    const fr = frameOf(n.callFrame);
    let nextLast = last, nextVia = via;
    if (fr) {
      if (last) {
        const key = `${last.file}:${last.line}:${last.col}>${fr.file}:${fr.line}:${fr.col}`;
        const e = out.get(key);
        if (e) { e.n += total.get(id)!; e.via ||= via; } else out.set(key, { a: last, b: fr, via, n: total.get(id)! });
      } else if (n.callFrame.functionName !== "(root)") {
        // first zod frame on a stack: its caller is the workload driver (outside the corpus)
        const key = `<workload>>${fr.file}:${fr.line}:${fr.col}`;
        const e = out.get(key);
        if (e) e.n += total.get(id)!; else out.set(key, { a: null, b: fr, via: false, n: total.get(id)! });
      }
      nextLast = fr; nextVia = false;
    } else if (last) nextVia = true;                       // a builtin / foreign frame sits between two zod frames
    for (const c of n.children ?? []) walk(c, nextLast, nextVia);
  };
  walk(profile.nodes[0].id, null, false);
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  const prof = await profile();
  console.log(`profile: ${prof.nodes.length} nodes, ${prof.samples.length} samples, ${((Date.now() - t0) / 1000).toFixed(1)}s, iters=${ITERS}, interval=${INTERVAL_US}us`);
  const edges = edgesOf(prof);
  indexStatic();

  const out: any[] = [];
  const tiers: Record<string, number> = {};
  const cache = new Map<string, Res>();
  const res = (f: Frame) => { const k = `${f.file}:${f.line}:${f.col}`; let r = cache.get(k); if (!r) { r = resolve(f); cache.set(k, r); } return r; };
  for (const e of edges.values()) {
    const rb = res(e.b);
    const ra = e.a ? res(e.a) : null;
    tiers[`callee:${rb.tier}`] = (tiers[`callee:${rb.tier}`] ?? 0) + 1;
    if (ra) tiers[`caller:${ra.tier}`] = (tiers[`caller:${ra.tier}`] ?? 0) + 1;
    out.push({
      kind: "calls",
      callerId: ra ? (ra.id ?? `runtime:${e.a!.file}:${e.a!.line}:${e.a!.fn || "anon"}`) : "external:workload",
      calleeName: e.b.fn || "(anonymous)",
      calleeId: rb.id ?? `runtime:${e.b.file}:${e.b.line}:${e.b.fn || "anon"}`,
      confidence: 0.95, reason: "runtime",
      callerKind: ra?.callerKind ?? "external",
      // line = caller function's start line: a sampling profiler sees functions, not call sites
      file: (e.a ?? e.b).file, line: (e.a ?? e.b).line,
      samples: e.n, viaNative: e.via,
      callerResolved: !!ra?.id, calleeResolved: !!rb.id, callerTier: ra?.tier ?? "external", calleeTier: rb.tier,
      callerFrame: e.a ? `${e.a.file}:${e.a.line}:${e.a.col}:${e.a.fn}` : "<workload>",
      calleeFrame: `${e.b.file}:${e.b.line}:${e.b.col}:${e.b.fn}`,
    });
  }
  const key = (e: any) => `${e.callerFrame}>${e.calleeFrame}`;
  out.forEach((e) => (e.runs = 1));
  let merged = out;
  if (process.env.TRACE_MERGE && fs.existsSync(OUT)) {   // union several processes: one-shot init edges are sampled by luck
    const m = new Map<string, any>(JSON.parse(fs.readFileSync(OUT, "utf-8")).map((e: any) => [key(e), e]));
    for (const e of out) { const p = m.get(key(e)); if (p) { p.samples += e.samples; p.runs += 1; p.viaNative ||= e.viaNative; } else m.set(key(e), e); }
    merged = [...m.values()];
  }
  fs.writeFileSync(OUT, JSON.stringify(merged));
  console.log(`merged edge total: ${merged.length}`);
  console.log(`edges: ${out.length}; resolution tiers`, tiers, `-> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
})();
