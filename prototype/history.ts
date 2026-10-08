// Does an entity-id scheme survive refactoring? Tests thesis.md §4.4 against real history.
//
//   npx tsx history.ts [--max N] [--jobs J] [--min-nodes K] [--commits sha,sha,...]
//
// Pipeline per commit: materialize tree (git archive from a SCRATCH COPY of the corpus's
// .git, never the shared zod-repo) -> run extract.ts with ATLAS_* env -> fingerprint every
// entity body -> cache. Then per adjacent pair: an id-scheme-independent oracle classifies
// entities, and each scheme's ids are scored against it.
//
// The schemes under test are DATA: every `*Id` field present on declaration facts
// (entityId, and contentId / structureId when the extractor emits them).
//
// Rerunning after the extractor's identity layer changes: delete $ATLAS_SCRATCH/log and /fp first
// (the per-commit cache is keyed by sha alone and would reuse stale entityId-only records).
// Setup: mkdir -p $ATLAS_SCRATCH/zodgit && cp -R <repo>/prototype/zod-repo/.git $ATLAS_SCRATCH/zodgit/.git
// (a read-only copy; git runs only there, never against the shared zod-repo). ATLAS_SCRATCH
// defaults to a session-specific path, so set it.
import { Project, Node, ts } from "ts-morph";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { createHash } from "crypto";
import { execFileSync, execSync, spawn } from "child_process";

// Defaults to a repo-relative directory rather than a session-specific
// /private/tmp path, so a rerun does not depend on one machine's scratchpad.
// ATLAS_SCRATCH overrides it.
const SCRATCH = process.env.ATLAS_SCRATCH ?? path.resolve(__dirname, ".history-cache");
// A read-only COPY of zod-repo/.git. git is never run against the shared
// corpus, whose working tree is pinned at e516c3b and underpins every
// measured number in the repo. Create it before the first run:
//   cp -R prototype/zod-repo/.git <SCRATCH>/zodgit
// It needs origin/main fetched to depth >= 500 for the 298 src-touching commits.
// The log/ and fp/ caches are keyed by commit sha ALONE, so any change to
// extract.ts's fact schema invalidates them: delete both before rerunning, or
// the harness silently reports the old schema's results.
const GITDIR = process.env.ATLAS_GITDIR ?? path.join(SCRATCH, "zodgit");
const arg = (n: string, d: number) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? +process.argv[i + 1] : d; };
const MAX = arg("max", 1e9), JOBS = arg("jobs", 4), MIN_NODES = arg("min-nodes", 12);
const SRC = "packages/zod/src";
for (const d of ["co", "facts", "fp", "log"]) fs.mkdirSync(path.join(SCRATCH, d), { recursive: true });

const git = (...a: string[]) => execFileSync("git", ["-C", GITDIR, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

// ─── Entity enumeration (independent of extract.ts's id layer) ──────────
// Mirrors extract.ts's declName/typeOfNode naming because the join to declaration facts is on
// (file, name, entityType). Drift shows up as a low join rate, which the report prints.
// Ported from extract.ts's identity layer. The join below is on
// (file, name, entityType), so any drift from extract.ts's declName shows up as
// a falling join rate, which this harness prints. Keep the two in step.
const bound = (n: any) => {
  const p = n.getParent?.();
  return !!p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p)
    || Node.isPropertyDeclaration(p) || Node.isPropertySignature(p) || Node.isTypeAliasDeclaration(p));
};
function anonSegment(node: any): string {
  const p = node.getParent?.();
  if (!p) return "@anon";
  const sibs = p.getChildren?.().filter((c: any) => c.getKind?.() === node.getKind()) ?? [];
  const i = sibs.findIndex((c: any) => c === node);
  return `@${node.getKindName().replace(/Expression$|Declaration$/, "").toLowerCase()}${i < 0 ? 0 : i}`;
}
function scopeSegment(a: any): string | null {
  if (Node.isClassDeclaration(a) || Node.isInterfaceDeclaration(a) || Node.isClassExpression(a)
      || Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) || Node.isMethodSignature(a)
      || Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a)
      || Node.isTypeAliasDeclaration(a) || Node.isEnumDeclaration(a)
      || Node.isVariableDeclaration(a) || Node.isPropertyAssignment(a)
      || Node.isPropertyDeclaration(a) || Node.isPropertySignature(a)
      || Node.isModuleDeclaration(a)) return a.getName?.() || null;
  if (Node.isConstructorDeclaration(a)) return "constructor";
  if (Node.isArrowFunction(a) || Node.isFunctionExpression(a)) return bound(a) ? null : anonSegment(a);
  if (Node.isTypeLiteral(a) || Node.isObjectLiteralExpression(a)) return bound(a) ? null : anonSegment(a);
  return null;
}
function scopePath(n: any): string[] {
  const out: string[] = [];
  for (let a = n.getParent?.(); a; a = a.getParent?.()) {
    if (Node.isSourceFile(a)) break;
    const seg = scopeSegment(a);
    if (seg) out.unshift(seg);
  }
  return out;
}
function isDefaultExport(n: any): boolean {
  try {
    if (n.hasModifier?.(SyntaxKind.DefaultKeyword)) return true;
    const p = n.getParent?.();
    return !!p && Node.isExportAssignment(p);
  } catch { return false; }
}
function declName(n: any): string | null {
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) {
    const p = n.getParent();
    if (p && (Node.isVariableDeclaration(p) || Node.isPropertyAssignment(p) || Node.isPropertyDeclaration(p))) return declName(p);
    if (isDefaultExport(n)) return [...scopePath(n), "default"].join(".");
    return null;
  }
  const own = Node.isConstructorDeclaration(n) ? "constructor"
    : (n.getName?.() || (isDefaultExport(n) ? "default" : null));
  if (!own) return null;
  return [...scopePath(n), own].join(".");
}
function entityType(n: any): string | null {
  if (Node.isClassDeclaration(n)) return "class";
  if (Node.isInterfaceDeclaration(n)) return "interface";
  if (Node.isTypeAliasDeclaration(n)) return "type";
  if (Node.isEnumDeclaration(n)) return "enum";
  if (Node.isFunctionDeclaration(n)) return "function";
  if (Node.isConstructorDeclaration(n)) return "constructor";
  if (Node.isMethodDeclaration(n) || Node.isMethodSignature(n)) return "method";
  if (Node.isGetAccessorDeclaration(n) || Node.isSetAccessorDeclaration(n)) return "accessor";
  if (Node.isPropertyDeclaration(n) || Node.isPropertySignature(n) || Node.isPropertyAssignment(n) || Node.isShorthandPropertyAssignment(n)) return "property";
  if (Node.isVariableDeclaration(n)) {
    const i = n.getInitializer?.();
    return i && (Node.isArrowFunction(i) || Node.isFunctionExpression(i)) ? "function" : "variable";
  }
  return null; // parameters, bindings, modules, source files: not oracle entities
}
const ORACLE_TYPES = new Set(["class", "interface", "type", "enum", "function", "constructor", "method", "accessor", "property", "variable"]);
const MEMBER_TYPES = new Set(["property", "method", "accessor", "constructor"]);

// ─── Body fingerprint ───────────────────────────────────────────────────
// Structural token stream of the node's subtree: SyntaxKind of every node plus the text of
// identifiers and literals. Comments, JSDoc and whitespace are not in the AST walk, so
// formatting / doc edits are NOT body edits. The entity's own (last-segment) name is replaced
// by $SELF everywhere in the body, including self-references, so a rename of a recursive
// function or a class does not look like an edit. The file path never enters: only the node
// subtree is hashed.
function fingerprint(node: any, own: string): { fp: string; n: number } {
  const last = own.split(".").pop()!;
  const out: string[] = [];
  const visit = (c: ts.Node) => {
    if (c.kind >= ts.SyntaxKind.FirstJSDocNode && c.kind <= ts.SyntaxKind.LastJSDocNode) return;
    let s = String(c.kind);
    if (ts.isIdentifier(c) || ts.isPrivateIdentifier(c)) s += ":" + (c.text === last ? "$SELF" : c.text);
    else if (ts.isStringLiteralLike(c) || ts.isNumericLiteral(c) || ts.isBigIntLiteral(c) || ts.isRegularExpressionLiteral(c)
      || ts.isTemplateHead(c) || ts.isTemplateMiddle(c) || ts.isTemplateTail(c)) s += ":" + c.text;
    out.push(s);
    ts.forEachChild(c, visit);
    out.push(")");
  };
  visit(node.compilerNode);
  return { fp: createHash("sha1").update(out.join(" ")).digest("hex").slice(0, 16), n: out.length >> 1 };
}

interface Rec {
  file: string; name: string; type: string; fp: string; n: number;
  dup: boolean;                 // key occurs >1 time (nested locals, declaration merging): not an oracle entity
  ids: Record<string, string>;  // scheme -> id, from the joined declaration fact
}
const key = (r: { file: string; name: string; type: string }) => `${r.file}\0${r.name}\0${r.type}`;

function buildRecords(checkout: string, facts: any[]): { recs: Rec[]; schemes: string[]; join: [number, number] } {
  const all = facts.filter(f => f.kind === "declaration");
  const decls = all.filter(f => ORACLE_TYPES.has(f.entityType));
  // Union over the declarations the oracle scores (not all[0], which may be a module fact).
  const schemes = [...new Set(decls.flatMap(f => Object.keys(f).filter(k => /Id$/.test(k))))];
  const byKey = new Map<string, any[]>();
  for (const d of decls) { const k = key({ file: d.file, name: d.name, type: d.entityType }); (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(d); }
  const root = path.join(checkout, SRC);
  const project = new Project({ skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: false } });
  const files = [...new Set(decls.map(d => d.file))].filter(f => /\.tsx?$/.test(f) && fs.existsSync(path.join(root, f)));
  const nodes = new Map<string, { node: any; name: string; type: string; file: string }[]>();
  for (const f of files) {
    const sf = project.addSourceFileAtPath(path.join(root, f));
    sf.forEachDescendant((n: any) => {
      const type = entityType(n); if (!type) return;
      const name = declName(n); if (!name) return;
      const r = { node: n, name, type, file: f };
      (nodes.get(key(r)) ?? nodes.set(key(r), []).get(key(r))!).push(r);
    });
  }
  const recs: Rec[] = []; let joined = 0;
  for (const [k, ns] of nodes) {
    const ds = byKey.get(k); if (!ds) continue;
    joined++;
    const { file, name, type, node } = ns[0];
    const { fp, n } = fingerprint(node, name);
    recs.push({ file, name, type, fp, n, dup: ns.length > 1 || ds.length > 1, ids: Object.fromEntries(schemes.map(s => [s, ds[0][s]])) });
  }
  return { recs, schemes, join: [joined, byKey.size] };
}

// ─── Per-commit prepare (cached) ────────────────────────────────────────
interface Meta { sha: string; files: number; exit: number | null; closed: string; integrity: string; joined: number; declKeys: number; schemes: string[]; error?: string }
const metaPath = (sha: string) => path.join(SCRATCH, "log", `${sha}.json`);

async function prepare(sha: string): Promise<void> {
  if (fs.existsSync(metaPath(sha))) return;
  const co = path.join(SCRATCH, "co", sha);
  fs.mkdirSync(co, { recursive: true });
  const factsPath = path.join(SCRATCH, "facts", `${sha}.json`);
  const meta: Meta = { sha, files: 0, exit: null, closed: "", integrity: "", joined: 0, declKeys: 0, schemes: [] };
  try {
    execSync(`git -C ${GITDIR} archive ${sha} | tar -x -C ${co}`, { stdio: "pipe", maxBuffer: 1 << 28 });
    const log: string = await new Promise(res => {
      let buf = "";
      const p = spawn(path.join(__dirname, "node_modules/.bin/tsx"), ["extract.ts"], {
        cwd: __dirname,
        env: { ...process.env, ATLAS_TARGET: path.join(co, SRC), ATLAS_TSCONFIG: path.join(co, "packages/zod/tsconfig.json"), ATLAS_OUT: factsPath },
      });
      p.stderr.on("data", d => buf += d); p.stdout.on("data", d => buf += d);
      p.on("close", c => { meta.exit = c; res(buf); });
    });
    meta.files = +(/Found (\d+) source files/.exec(log)?.[1] ?? 0);
    meta.closed = /Closed edges[^\n]*/.exec(log)?.[0] ?? "";
    meta.integrity = /(Referential integrity[^\n]*)/.exec(log)?.[1]?.slice(0, 60) ?? "";
    if (!fs.existsSync(factsPath)) throw new Error("no facts written:\n" + log.slice(-500));
    const facts = JSON.parse(fs.readFileSync(factsPath, "utf8"));
    const { recs, schemes, join } = buildRecords(co, facts);
    meta.schemes = schemes; [meta.joined, meta.declKeys] = join;
    fs.writeFileSync(path.join(SCRATCH, "fp", `${sha}.json`), JSON.stringify({ schemes, recs }));
    fs.writeFileSync(factsPath + ".gz", zlib.gzipSync(fs.readFileSync(factsPath))); fs.rmSync(factsPath);
  } catch (e: any) { meta.error = String(e.message ?? e).slice(0, 400); }
  fs.rmSync(co, { recursive: true, force: true });
  fs.writeFileSync(metaPath(sha), JSON.stringify(meta));
}

// ─── The oracle ─────────────────────────────────────────────────────────
type Cat = "unchanged" | "body_edit" | "rename" | "rename_owner" | "move" | "rename_move" | "ambiguous" | "added" | "removed" | "excluded";
const CATS: Cat[] = ["unchanged", "body_edit", "rename", "rename_owner", "move", "rename_move", "ambiguous", "added", "removed"];
interface Row { cat: Cat; type: string; a?: Rec; b?: Rec }

function oracle(A: Rec[], B: Rec[]): Row[] {
  const rows: Row[] = [];
  const dupA = new Set(A.filter(r => r.dup).map(key)), dupB = new Set(B.filter(r => r.dup).map(key));
  const ea = A.filter(r => !r.dup && !dupB.has(key(r))), eb = B.filter(r => !r.dup && !dupA.has(key(r)));
  const mb = new Map(eb.map(r => [key(r), r]));
  const usedB = new Set<Rec>();
  let la: Rec[] = [];
  // Stage 1: same (file, name, type). Pairs on path+name, i.e. exactly what entityId encodes,
  // so entityId surviving unchanged / body_edit is true by construction; renames and moves
  // are its real test.
  for (const a of ea) {
    const b = mb.get(key(a));
    if (b) { usedB.add(b); rows.push({ cat: a.fp === b.fp ? "unchanged" : "body_edit", type: a.type, a, b }); } else la.push(a);
  }
  let lb = eb.filter(b => !usedB.has(b));
  // Stage 2: among leftovers only, pair on the name- and path-free body fingerprint. A pair is
  // accepted only if its bucket is 1:1 (else "ambiguous": boilerplate bodies can't be told apart)
  // and the body has >= MIN_NODES nodes (`foo: string` is the same body as `bar: string`).
  const stage = (bucket: (r: Rec) => string, cat: (a: Rec, b: Rec) => Cat | null) => {
    const ga = new Map<string, Rec[]>(), gb = new Map<string, Rec[]>();
    for (const a of la) if (a.n >= MIN_NODES) (ga.get(bucket(a)) ?? ga.set(bucket(a), []).get(bucket(a))!).push(a);
    for (const b of lb) if (b.n >= MIN_NODES) (gb.get(bucket(b)) ?? gb.set(bucket(b), []).get(bucket(b))!).push(b);
    const gone = new Set<Rec>();
    for (const [k, xs] of ga) {
      const ys = gb.get(k); if (!ys) continue;
      if (xs.length === 1 && ys.length === 1) {
        const c = cat(xs[0], ys[0]); if (!c) continue;
        rows.push({ cat: c, type: xs[0].type, a: xs[0], b: ys[0] }); gone.add(xs[0]); gone.add(ys[0]);
      } else if (xs.length && ys.length) {
        for (const r of [...xs, ...ys]) gone.add(r);
        rows.push({ cat: "ambiguous", type: xs[0].type, a: xs[0] }); // one row per ambiguous bucket
      }
    }
    la = la.filter(r => !gone.has(r)); lb = lb.filter(r => !gone.has(r));
  };
  const lastSeg = (n: string) => n.split(".").pop();
  stage(r => `${r.file}\0${r.type}\0${r.fp}`, (a, b) => lastSeg(a.name) === lastSeg(b.name) ? "rename_owner" : "rename"); // same file+body
  stage(r => `${lastSeg(r.name)}\0${r.type}\0${r.fp}`, (a, b) => a.file !== b.file ? "move" : null);                      // same name+body
  stage(r => `${r.type}\0${r.fp}`, () => "rename_move");                                                               // neither
  for (const a of la) rows.push({ cat: "removed", type: a.type, a });
  for (const b of lb) rows.push({ cat: "added", type: b.type, b });
  return rows;
}

// ─── Scoring ────────────────────────────────────────────────────────────
// Outcomes for a pair the oracle says is the same entity:
//   survive  — the scheme gives it the same id in both commits
//   vanish   — id changed and the old id exists nowhere in the new commit (identity lost)
//   alias    — id changed AND the old id now names some other entity (identity corrupted)
// For added/removed (no counterpart): "reappear" = the id exists on the other side anyway,
// i.e. the scheme claims continuity the oracle can't find. Includes type-change cases and
// structural collisions.
type Out = "survive" | "vanish" | "alias" | "reappear" | "none" | "missing";
interface Tally { n: number; byScheme: Record<string, Record<Out, number>> }
const blank = (schemes: string[]): Tally => ({ n: 0, byScheme: Object.fromEntries(schemes.map(s => [s, { survive: 0, vanish: 0, alias: 0, reappear: 0, none: 0, missing: 0 }])) });

function score(rows: Row[], A: Rec[], B: Rec[], schemes: string[], slice: (type: string) => boolean, into: Map<Cat, Tally>) {
  const idsA = Object.fromEntries(schemes.map(s => [s, new Set(A.map(r => r.ids[s]))]));
  const idsB = Object.fromEntries(schemes.map(s => [s, new Set(B.map(r => r.ids[s]))]));
  for (const row of rows) {
    if (!slice(row.type)) continue;
    const t = into.get(row.cat) ?? into.set(row.cat, blank(schemes)).get(row.cat)!;
    t.n++;
    for (const s of schemes) {
      const o = t.byScheme[s];
      if (row.cat === "ambiguous") continue;
      // A scheme absent on a declaration is "missing", never a survival (undefined === undefined).
      if ((row.a && row.a.ids[s] == null) || (row.b && row.b.ids[s] == null)) { o.missing++; continue; }
      if (row.a && row.b) {
        if (row.a.ids[s] === row.b.ids[s]) o.survive++;
        else if (idsB[s].has(row.a.ids[s])) o.alias++; else o.vanish++;
      } else if (row.a) { if (idsB[s].has(row.a.ids[s])) o.reappear++; else o.none++; }
      else if (row.b) { if (idsA[s].has(row.b.ids[s])) o.reappear++; else o.none++; }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  // Linear first-parent history: pair = (parent, commit) for each commit touching the src tree.
  const lines = git("log", "--first-parent", "--format=%H %P", "origin/main", "--", SRC).trim().split("\n").map(l => l.split(" "));
  const pairs = lines.filter(l => l.length === 2).map(l => ({ child: l[0], parent: l[1] })).reverse(); // oldest first
  // --commits <sha,sha,...> scores only the pairs whose child is listed. The
  // fact cache is keyed by sha alone, so a schema change to extract.ts
  // invalidates all 389 cached fact bases and a full rerun costs ~40min. This
  // targets the commits that actually carry a category under test.
  const only = (() => { const i = process.argv.indexOf("--commits"); return i > 0 ? new Set(process.argv[i + 1].split(",")) : null; })();
  const picked = only ? pairs.filter(p => [...only].some(s => p.child.startsWith(s))) : pairs;
  if (only) console.log(`--commits matched ${picked.length} of ${pairs.length} pairs`);
  const sel = picked.length <= MAX ? picked : Array.from({ length: MAX }, (_, i) => picked[Math.floor(i * picked.length / MAX)]);
  console.log(`src-touching commits: ${lines.length}; with a parent: ${pairs.length}; sampling ${sel.length} pairs`);
  const shas = [...new Set(sel.flatMap(p => [p.parent, p.child]))];
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (next < shas.length) {
      const sha = shas[next++];
      await prepare(sha);
      if (++done % 10 === 0) process.stderr.write(`prepared ${done}/${shas.length}\n`);
    }
  }));
  const metas = shas.map(s => JSON.parse(fs.readFileSync(metaPath(s), "utf8")) as Meta);
  const bad = metas.filter(m => m.error || m.files < 100);
  console.log(`extraction: ${metas.length} commits; source files min/max ${Math.min(...metas.map(m => m.files))}/${Math.max(...metas.map(m => m.files))}; `
    + `failed or <100 files: ${bad.length}; extract exit!=0: ${metas.filter(m => m.exit).length}`);
  for (const m of bad.slice(0, 5)) console.log("  bad:", m.sha.slice(0, 8), m.files, m.error ?? "");
  const okSha = new Set(metas.filter(m => !m.error && m.files >= 100).map(m => m.sha));
  const load = (sha: string) => JSON.parse(fs.readFileSync(path.join(SCRATCH, "fp", `${sha}.json`), "utf8")) as { schemes: string[]; recs: Rec[] };
  const joinRates = metas.filter(m => !m.error).map(m => m.joined / Math.max(1, m.declKeys));
  console.log(`oracle<->declaration-fact join rate (entity keys): min ${(100 * Math.min(...joinRates)).toFixed(1)}% mean ${(100 * joinRates.reduce((a, b) => a + b, 0) / joinRates.length).toFixed(1)}%`);

  const slices: Record<string, (t: string) => boolean> = {
    "ALL entities": () => true,
    "NON-MEMBER only (class/interface/type/enum/function/variable)": t => !MEMBER_TYPES.has(t),
  };
  const agg: Record<string, Map<Cat, Tally>> = Object.fromEntries(Object.keys(slices).map(k => [k, new Map()]));
  const perPair: { child: string; counts: Record<string, number> }[] = [];
  const examples: Record<string, string[]> = {};
  let schemes: string[] = [], used = 0;
  const blind = { removed: 0, sameFileSibling: 0, sameNameElsewhere: 0, fileGone: 0 };
  for (const p of sel) {
    if (!okSha.has(p.parent) || !okSha.has(p.child)) continue;
    const A = load(p.parent), B = load(p.child);
    schemes = A.schemes.filter(s => B.schemes.includes(s));
    const rows = oracle(A.recs, B.recs);
    used++;
    const counts: Record<string, number> = {};
    for (const r of rows) { counts[r.cat] = (counts[r.cat] ?? 0) + 1; if (/^(rename|rename_owner|move|rename_move|ambiguous)$/.test(r.cat) && (examples[r.cat] ??= []).length < 6)
      examples[r.cat].push(`${p.child.slice(0, 7)} ${r.a?.file}:${r.a?.name} -> ${r.b ? `${r.b.file}:${r.b.name}` : "(bucket)"} [${r.a?.type}, ${r.a?.n} nodes]`); }
    // Why does an id "reappear" for an entity the oracle calls added/removed? Show the other-side type.
    const typeOfId = (R: Rec[]) => new Map(R.map(r => [r.ids[schemes[0]], r.type]));
    const tA = typeOfId(A.recs), tB = typeOfId(B.recs);
    for (const r of rows) {
      const here = r.a ?? r.b!, other = r.cat === "removed" ? tB : tA;
      if ((r.cat === "removed" || r.cat === "added") && other.has(here.ids[schemes[0]]) && (examples[`${r.cat}-but-${schemes[0]}-reappears`] ??= []).length < 8)
        examples[`${r.cat}-but-${schemes[0]}-reappears`].push(`${p.child.slice(0, 7)} ${here.file}:${here.name} [${here.type} -> ${other.get(here.ids[schemes[0]])} on the other side]`);
    }
    perPair.push({ child: p.child, counts });
    // Blind-spot probe: rename/move combined with a body edit is invisible to the oracle and lands
    // in removed+added. Bound it: removed entities that have a plausible edited successor.
    const addedB = rows.filter(r => r.cat === "added").map(r => r.b!);
    const bFiles = new Set(B.recs.map(r => r.file));
    for (const r of rows) if (r.cat === "removed") {
      blind.removed++;
      if (addedB.some(b => b.file === r.a!.file && b.type === r.a!.type)) blind.sameFileSibling++;
      const mv = addedB.find(b => b.file !== r.a!.file && b.type === r.a!.type && b.name === r.a!.name);
      if (mv) { blind.sameNameElsewhere++; if (!MEMBER_TYPES.has(r.a!.type)) (examples["candidate-edited-move (heuristic, NOT oracle-verified; non-member types)"] ??= []).push(`${p.child.slice(0, 7)} ${r.a!.file} -> ${mv.file}: ${r.a!.name} [${r.a!.type}, ${r.a!.n} -> ${mv.n} nodes]`); }
      if (!bFiles.has(r.a!.file)) blind.fileGone++;
    }
    for (const [k, f] of Object.entries(slices)) score(rows, A.recs, B.recs, schemes, f, agg[k]);
  }
  console.log(`\nPAIRS USED: ${used} (of ${sel.length} sampled); oracle min body size for fingerprint matching: ${MIN_NODES} nodes; schemes: ${schemes.join(", ")}`);
  console.log(`pairs with >=1 rename: ${perPair.filter(p => p.counts.rename).length}, rename_owner: ${perPair.filter(p => p.counts.rename_owner).length}, move: ${perPair.filter(p => p.counts.move).length}, rename_move: ${perPair.filter(p => p.counts.rename_move).length}, body_edit: ${perPair.filter(p => p.counts.body_edit).length}`);

  console.log(`blind-spot bound (removed entities that could be edited renames/moves): removed=${blind.removed}; has an added same-type entity in same file=${blind.sameFileSibling}; `
    + `added same-name+type in another file=${blind.sameNameElsewhere}; whole file gone=${blind.fileGone}`);
  console.log(`distinct commits (pairs) containing each oracle category: ` + CATS.map(c => `${c}=${perPair.filter(p => p.counts[c]).length}`).join(" "));
  const pct = (x: number, n: number) => n ? `${(100 * x / n).toFixed(1)}%` : "-";
  for (const [name, m] of Object.entries(agg)) {
    console.log(`\n=== ${name} ===`);
    const total = CATS.reduce((a, c) => a + (m.get(c)?.n ?? 0), 0);
    console.log("oracle distribution:");
    for (const c of CATS) console.log(`  ${c.padEnd(13)} ${String(m.get(c)?.n ?? 0).padStart(8)}  ${pct(m.get(c)?.n ?? 0, total)}${(m.get(c)?.n ?? 0) < 30 && c !== "ambiguous" ? "   <-- EMPTY/NEAR-EMPTY: corpus cannot test this direction" : ""}`);
    for (const s of schemes) {
      console.log(`scheme ${s}:`);
      console.log("  category       n        survive   vanish(id lost)  alias(id->other)   | no-counterpart: id reappears elsewhere");
      for (const c of CATS) {
        const t = m.get(c); if (!t || c === "ambiguous") continue;
        const o = t.byScheme[s];
        if (c === "added" || c === "removed") console.log(`  ${c.padEnd(13)} ${String(t.n).padStart(7)}   ${"".padEnd(8)} ${"".padEnd(16)} ${"".padEnd(17)}  | ${o.reappear} (${pct(o.reappear, t.n)})`);
        else console.log(`  ${c.padEnd(13)} ${String(t.n).padStart(7)}   ${pct(o.survive, t.n).padStart(8)} ${(o.vanish + " " + pct(o.vanish, t.n)).padEnd(16)} ${(o.alias + " " + pct(o.alias, t.n)).padEnd(17)}  |`);
      }
      const miss = CATS.reduce((a, c) => a + (m.get(c)?.byScheme[s].missing ?? 0), 0);
      if (miss) console.log(`  note: ${miss} entities had no ${s} on their declaration fact and are excluded from the rows above`);
      const u = m.get("unchanged"); if (u && u.byScheme[s].survive + u.byScheme[s].missing !== u.n) console.log(`  !!! HARNESS BUG: ${s} kept only ${u.byScheme[s].survive}/${u.n} unchanged entities`);
    }
  }
  console.log("\nexamples (first few per category):");
  for (const [c, xs] of Object.entries(examples)) { console.log(` ${c}: (${xs.length})`); for (const x of xs.filter((x, i) => c.startsWith("candidate") ? !x.startsWith("d3355f7") || i < 2 : i < 8)) console.log("   " + x); }
}
main();
