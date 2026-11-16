// Deterministic runtime capture with call-site positions.
//
// trace.ts samples stacks, so it sees functions, not call sites, and a one-shot
// edge is caught by luck (58 of 548 edges were seen by 1 run in 12). ADR-0001
// makes runtime ingestion conditional on capture that is deterministic and
// carries call sites. This is that capture: the corpus is rewritten so every
// call expression and every function entry reports itself, then a workload runs
// against the rewritten copy. Nothing is sampled; two runs give the same bytes.
//
//   f(a)      ->  __A.f(site, f, [a])           a.b(c)  ->  __A.m(site, a, "b", [c])
//   new C(a)  ->  __A.n(site, C, [a])           body    ->  __A.e(fn); body
//
// An edge is (call site -> function entered), and it is one of four kinds:
//   direct    the function entered is the one the call expression called
//   lookup    entered while the site read its callee: `x.parse` is a getter
//             that installs the method, which is how Zod wires its public API
//   native    entered while the site's callee, a builtin, was running (`xs.map(cb)`)
//   implicit  entered with no call expression pending: a getter read outside a
//             call, a field initializer, or a call form left unrewritten
// The caller of the first three is static, from the site: `callerId` is the
// attribution `calls` facts use (identity.ts callSite) and `callerFn` the
// function the site is written in. Only an implicit edge takes its caller from
// run-time state.
//
// Run: cd prototype && npx tsx trace-exact.ts      (ATLAS_ZOD_REPO as for trace.ts)
import * as fs from "fs";
import * as path from "path";
import { Project, Node, SyntaxKind, ts } from "ts-morph";
import { setRoot, idOfNode, callSite, mid } from "./identity";

const CORPUS = process.env.ATLAS_ZOD_REPO ?? path.resolve(__dirname, "zod-repo");
const PKG = path.join(CORPUS, "packages/zod");
const SRC = path.join(PKG, "src");
const WORK = path.resolve(__dirname, ".history-cache/trace-exact");
const OUT = process.env.TRACE_OUT ?? path.resolve(__dirname, "facts.runtime.exact.json");
const ITERS = Number(process.env.TRACE_ITERS ?? 3);

// The workload is rewritten and resolved like corpus code, so its call sites
// carry the static target of `.parse(` (ADR-0001's third precondition). It is
// the same set of operations trace.ts runs.
const WORKLOAD = "__workload.ts";
const WORKLOAD_SRC = `import * as z from "./v4/classic/external.js";
export async function workload(iters: number) {
  const shared = z.object({ name: z.string().min(2), age: z.number().int(), tags: z.array(z.string()).optional() });
  const un = z.union([z.string(), z.number()]);
  for (let i = 0; i < iters; i++) {
    z.string().parse("x");
    z.object({ a: z.string() }).parse({ a: "y" });
    shared.parse({ name: "bob", age: 3, tags: ["a", "b"] });
    shared.safeParse({ name: "b", age: 3.5 });
    try { z.number().parse("nope"); } catch {}
    un.parse(i % 2 ? "s" : 4);
    z.string().transform((s: string) => s.length).parse("abc");
    z.string().refine((s: string) => s.length > 1).safeParse("a");
    if (i % 50 === 0) await z.string().parseAsync("async");
  }
}
`;

// ── 1. index: every call site and function, with the ids static facts use ──
interface Site { file: string; line: number; col: number; name: string | null; callerId: string; callerFn: string; isNew: boolean; staticId: string | null; }
interface Fn { id: string | null; file: string; line: number; name: string; }
const sites: Site[] = [], fns: Fn[] = [];
const siteK = new Map<string, number>(), fnK = new Map<string, number>();
const skipped: Record<string, number> = Object.create(null);
const FN_KINDS = [SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration, SyntaxKind.Constructor, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor];

const facts: any[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, "facts.json"), "utf-8"));
const declType = new Map<string, string>(facts.filter((f) => f.kind === "declaration").map((f) => [f.entityId, f.entityType]));
// Static calls are unique on (file, line, calleeName), so the site is a join key.
const staticAt = new Map<string, string | null>();
for (const f of facts) {
  if (f.kind === "calls") staticAt.set(`${f.file}:${f.line}:${f.calleeName}`, f.calleeId ?? null);
  if (f.kind === "instantiates") staticAt.set(`${f.file}:${f.line}:new ${f.className}`, f.classId ?? null);
}

const outer = (e: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
};
const keyOf = (rel: string, n: ts.Node, sf: ts.SourceFile) => `${rel}:${n.getStart(sf)}:${n.getEnd()}:${n.kind}`;

// Why a call expression is left as it is. Each of these still shows up at run
// time, as an implicit edge with the right caller and no site.
function unrewritable(call: any): string | null {
  if (Node.isNewExpression(call)) return null;
  const c: ts.CallExpression = call.compilerNode;
  if (c.expression.kind === ts.SyntaxKind.SuperKeyword) return "super()";
  if (c.expression.kind === ts.SyntaxKind.ImportKeyword) return "import()";
  if (c.flags & ts.NodeFlags.OptionalChain) return "optional chain";
  const e = outer(c.expression);
  if (ts.isPropertyAccessExpression(e)) {
    if (e.expression.kind === ts.SyntaxKind.SuperKeyword) return "super.method()";
    if (ts.isPrivateIdentifier(e.name)) return "private name";
  }
  if (ts.isIdentifier(e) && e.text === "eval") return "eval";
  return null;
}

function index(project: Project) {
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (!fp.startsWith(SRC + "/") || fp.includes("/tests/") || fp.includes(".test.") || fp.endsWith(".d.ts")) continue;
    const rel = path.relative(SRC, fp), csf = sf.compilerNode, moduleId = mid(fp);
    for (const k of FN_KINDS) for (const n of sf.getDescendantsOfKind(k) as any[]) {
      if (!n.getBody?.()) continue; // overload signature, abstract or ambient
      fnK.set(keyOf(rel, n.compilerNode, csf), fns.length);
      fns.push({ id: idOfNode(n), file: rel, line: n.getStartLineNumber(), name: n.getName?.() ?? "" });
    }
    for (const call of [...sf.getDescendantsOfKind(SyntaxKind.CallExpression), ...sf.getDescendantsOfKind(SyntaxKind.NewExpression)] as any[]) {
      const why = unrewritable(call);
      if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
      const isNew = Node.isNewExpression(call), expr = call.getExpression();
      // The name static facts carry: source text of an identifier or property access, else no fact.
      const name: string | null = Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr) ? expr.getText() : null;
      const { line, character } = csf.getLineAndCharacterOfPosition(call.getStart());
      let staticId = name === null ? null : staticAt.get(`${rel}:${line + 1}:${isNew ? "new " : ""}${name}`) ?? null;
      if (rel === WORKLOAD && name !== null) {
        // Not in facts.json, so resolve its sites here. The id still comes from identity.ts.
        const nameNode = Node.isPropertyAccessExpression(expr) ? expr.getNameNode() : expr;
        const d = nameNode.getDefinitions()[0]?.getDeclarationNode();
        staticId = d ? idOfNode(d) : null;
      }
      // callSite skips anonymous functions, so `callerId` can be an owner two
      // levels up. Reachability needs the function the site is actually in.
      const inFn = call.getFirstAncestor((a: any) => FN_KINDS.includes(a.getKind()) && !!a.getBody?.());
      siteK.set(keyOf(rel, call.compilerNode, csf), sites.length);
      sites.push({ file: rel, line: line + 1, col: character, name, callerId: callSite(call, moduleId).callerId,
        callerFn: (inFn && idOfNode(inFn)) || moduleId, isNew, staticId });
    }
  }
}

// ── 2. rewrite ─────────────────────────────────────────────────────────────
function rewrite(sf: any): string {
  const csf: ts.SourceFile = sf.compilerNode, rel = path.relative(SRC, sf.getFilePath());
  const tx: ts.TransformerFactory<ts.SourceFile> = (ctx) => {
    const f = ctx.factory;
    const A = (m: string, args: ts.Expression[]) =>
      f.createCallExpression(f.createPropertyAccessExpression(f.createIdentifier("__A"), m), undefined, args);
    const num = (k: number) => f.createNumericLiteral(k);
    const visit = (node: ts.Node): ts.Node => {
      const v = ts.visitEachChild(node, visit, ctx);
      const sk = siteK.get(keyOf(rel, node, csf));
      if (sk !== undefined && (ts.isCallExpression(v) || ts.isNewExpression(v))) {
        const args = f.createArrayLiteralExpression(v.arguments ?? []);
        if (ts.isNewExpression(v)) return A("n", [num(sk), v.expression, args]);
        // shortcut: `a.b` is read after the arguments are evaluated, not before;
        // upgrade if a corpus has arguments that rebind the method they are passed to.
        const e = outer(v.expression);
        if (ts.isPropertyAccessExpression(e)) return A("m", [num(sk), e.expression, f.createStringLiteral(e.name.text), args]);
        if (ts.isElementAccessExpression(e)) return A("m", [num(sk), e.expression, e.argumentExpression, args]);
        return A("f", [num(sk), v.expression, args]);
      }
      const fk = fnK.get(keyOf(rel, node, csf));
      if (fk === undefined) return v;
      const enter = A("e", [num(fk)]);
      const b = (v as any).body as ts.ConciseBody;
      const body: any = ts.isBlock(b)
        ? f.updateBlock(b, [f.createExpressionStatement(enter), ...b.statements])
        : f.createParenthesizedExpression(f.createComma(enter, b));
      if (ts.isFunctionDeclaration(v)) return f.updateFunctionDeclaration(v, v.modifiers, v.asteriskToken, v.name, v.typeParameters, v.parameters, v.type, body);
      if (ts.isFunctionExpression(v)) return f.updateFunctionExpression(v, v.modifiers, v.asteriskToken, v.name, v.typeParameters, v.parameters, v.type, body);
      if (ts.isArrowFunction(v)) return f.updateArrowFunction(v, v.modifiers, v.typeParameters, v.parameters, v.type, v.equalsGreaterThanToken, body);
      if (ts.isMethodDeclaration(v)) return f.updateMethodDeclaration(v, v.modifiers, v.asteriskToken, v.name, v.questionToken, v.typeParameters, v.parameters, v.type, body);
      if (ts.isConstructorDeclaration(v)) return f.updateConstructorDeclaration(v, v.modifiers, v.parameters, body);
      if (ts.isGetAccessorDeclaration(v)) return f.updateGetAccessorDeclaration(v, v.modifiers, v.name, v.parameters, v.type, body);
      if (ts.isSetAccessorDeclaration(v)) return f.updateSetAccessorDeclaration(v, v.modifiers, v.name, v.parameters, body);
      return v;
    };
    return (s) => ts.visitNode(s, visit) as ts.SourceFile;
  };
  const res = ts.transform(csf, [tx]);
  const text = ts.createPrinter().printFile(res.transformed[0]);
  res.dispose();
  return text;
}

// ── 3. run-time half ───────────────────────────────────────────────────────
// `cur` is the innermost call expression still executing. Each wrapper restores
// it on the way out, so a pending site can never leak to a later, unrelated entry.
interface Rec { site: number; fn: number; native: boolean; lookup: boolean; prev: Rec | null; }
let cur: Rec | null = null;
const counts = new Map<string, number>();
const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
const nativeOf = new WeakMap<object, boolean>();
// A bound function prints as native code but enters its target at once, so it is a direct call.
const isNative = (fn: any) => {
  if (typeof fn !== "function") return false;
  let n = nativeOf.get(fn);
  if (n === undefined) nativeOf.set(fn, n = !fn.name.startsWith("bound ") && /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn)));
  return n;
};
const run = <T>(site: number, go: (rec: Rec) => T): T => {
  const rec: Rec = { site, fn: -1, native: false, lookup: false, prev: cur };
  cur = rec;
  try { return go(rec); } finally { cur = rec.prev; }
};
(globalThis as any).__A = {
  f: (s: number, fn: any, args: any[]) => run(s, (r) => { r.native = isNative(fn); return Reflect.apply(fn, undefined, args); }),
  m: (s: number, base: any, key: any, args: any[]) => run(s, (r) => {
    r.lookup = true; const fn = base[key]; r.lookup = false;
    r.native = isNative(fn);
    return Reflect.apply(fn, base, args);
  }),
  n: (s: number, ctor: any, args: any[]) => run(s, (r) => { r.native = isNative(ctor); return Reflect.construct(ctor, args); }),
  e: (k: number) => {
    const r = cur;
    if (!r) bump(`i -1 ${k}`);
    else if (r.lookup) bump(`g ${r.site} ${k}`);
    else if (r.native) bump(`n ${r.site} ${k}`);
    else if (r.fn < 0) { r.fn = k; bump(`d ${r.site} ${k}`); }
    else bump(`i ${r.fn} ${k}`);
  },
};

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  setRoot(SRC);
  const project = new Project({ tsConfigFilePath: path.join(PKG, "tsconfig.json") });
  project.createSourceFile(path.join(SRC, WORKLOAD), WORKLOAD_SRC); // in memory; the corpus checkout is not written to
  index(project);

  fs.rmSync(WORK, { recursive: true, force: true });
  const dst = path.join(WORK, "packages/zod");
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(PKG, "package.json"), path.join(dst, "package.json")); // keeps the module type
  for (const sf of project.getSourceFiles()) {
    const fp = sf.getFilePath();
    if (!fp.startsWith(SRC + "/") || fp.endsWith(".d.ts")) continue;
    const to = path.join(dst, "src", path.relative(SRC, fp));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fp.includes("/tests/") || fp.includes(".test.") ? sf.getFullText() : rewrite(sf));
  }

  const { workload } = await import(path.join(dst, "src", WORKLOAD));
  await workload(ITERS);

  const out: any[] = [];
  for (const [k, count] of counts) {
    const [kind, a, b] = k.split(" "), fn = fns[+b];
    const calleeId = fn.id ?? `runtime:${fn.file}:${fn.line}:${fn.name || "anon"}`;
    if (kind === "i") {
      const from = +a >= 0 ? fns[+a] : null;
      out.push({ kind: "calls", via: "implicit", callerId: from ? from.id ?? `runtime:${from.file}:${from.line}` : "unknown",
        calleeName: fn.name || "(anonymous)", calleeId, confidence: 0.95, reason: "runtime", count });
    } else {
      const s = sites[+a];
      out.push({ kind: "calls", via: kind === "d" ? "direct" : kind === "g" ? "lookup" : "native", callerId: s.callerId, callerFn: s.callerFn, calleeName: s.name,
        calleeId, staticCalleeId: s.staticId, isNew: s.isNew, confidence: 0.95, reason: "runtime", file: s.file, line: s.line, col: s.col, count });
    }
  }
  const order = (e: any) => `${e.file ?? ""}:${String(e.line ?? 0).padStart(6, "0")}:${String(e.col ?? 0).padStart(4, "0")}:${e.via}:${e.callerId}:${e.calleeId}`;
  out.sort((x, y) => (order(x) < order(y) ? -1 : 1));
  fs.writeFileSync(OUT, `[\n${out.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`); // one edge per line, so a change diffs

  // ── report ──
  const pct = (a: number, b: number) => `${a} of ${b} (${b ? ((100 * a) / b).toFixed(1) : "-"}%)`;
  const by = (via: string) => out.filter((e) => e.via === via);
  const total = (xs: any[]) => xs.reduce((n, e) => n + e.count, 0);
  const isWorkload = (id: string) => id.startsWith(`ts:${WORKLOAD}:`) || id === `module:${WORKLOAD}`;
  console.log(`rewrote ${sites.length} call sites and ${fns.length} function bodies; left as written: ${JSON.stringify(skipped)}`);
  console.log(`workload: ${ITERS} iterations, ${total(out)} function entries, ${out.length} distinct edges -> ${OUT}`);
  for (const v of ["direct", "lookup", "native", "implicit"]) console.log(`  ${v.padEnd(8)} ${String(by(v).length).padStart(5)} edges, ${total(by(v))} entries`);
  const corpus = out.filter((e) => e.file !== WORKLOAD && !isWorkload(e.calleeId) && e.callerId !== "unknown");
  console.log(`corpus edges with both ends declared in facts.json: ${pct(corpus.filter((e) => declType.has(e.calleeId) && declType.has(e.callerId) && declType.has(e.callerFn ?? e.callerId)).length, corpus.length)}`);
  const staticSites = facts.filter((f) => f.kind === "calls" || f.kind === "instantiates").length;
  const ranAt = new Set(out.filter((e) => e.file && e.file !== WORKLOAD && e.calleeName !== null).map((e) => `${e.file}:${e.line}:${e.isNew ? "new " : ""}${e.calleeName}`));
  console.log(`static call and instantiation sites the workload reached: ${pct([...ranAt].filter((k) => staticAt.has(k)).length, staticSites)}`);

  // What the site's static fact said, against what ran there.
  const direct = by("direct").filter((e) => e.file !== WORKLOAD);
  const cmp: Record<string, number> = Object.create(null);
  const filled = new Map<string, Set<string>>();
  for (const e of direct) {
    const s = e.staticCalleeId as string | null;
    const how = e.calleeName === null ? "no static fact: the callee is not a name"
      : s === null ? "static unresolved"
      : s === e.calleeId ? "same entity"
      : `static: ${declType.get(s) ?? "?"}; ran: ${isWorkload(e.calleeId) ? "workload callback" : declType.get(e.calleeId) ?? "?"}`;
    cmp[how] = (cmp[how] || 0) + 1;
    if (s && s !== e.calleeId) (filled.get(s) ?? filled.set(s, new Set()).get(s)!).add(e.calleeId);
  }
  console.log(`direct edges at corpus call sites, ${direct.length}:`);
  for (const [k, n] of Object.entries(cmp).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
  const fan = [...filled.values()].map((v) => v.size);
  console.log(`static targets that never ran themselves: ${filled.size}, of which ${fan.filter((n) => n > 1).length} dispatched to more than one function (max ${Math.max(0, ...fan)})`);

  // Q5: what runs when a user calls the public parse?
  const next = new Map<string, Set<string>>();
  for (const e of out) { const from = e.callerFn ?? e.callerId; (next.get(from) ?? next.set(from, new Set()).get(from)!).add(e.calleeId); }
  const reach = (seeds: string[]) => { const seen = new Set(seeds), st = [...seeds]; while (st.length) for (const n of next.get(st.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), st.push(n)); return seen; };
  const short = (id: string) => id.replace(/^ts:/, "");
  for (const pub of ["ts:v4/classic/schemas.ts:ZodType.parse", "ts:v4/classic/schemas.ts:ZodType.safeParse", "ts:v4/classic/schemas.ts:ZodType.parseAsync"]) {
    const at = out.filter((e) => e.staticCalleeId === pub);
    const ids = (via: string) => [...new Set(at.filter((e) => e.via === via).map((e) => e.calleeId))];
    const impls = ids("direct");
    console.log(`${short(pub)}: ${new Set(at.map((e) => `${e.line}:${e.col}`)).size} call sites`);
    console.log(`  reading the member ran: ${ids("lookup").map(short).join(", ") || "(nothing)"}`);
    console.log(`  the call entered:       ${impls.map(short).join(", ") || "(nothing)"}`);
    console.log(`  entities reached from there: ${impls.length ? reach(impls).size - impls.length : 0}`);
  }
})();
