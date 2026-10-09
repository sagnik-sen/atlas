# Atlas Prototype Report

Analysis of whether Atlas's core hypothesis is true, based on a throwaway fact extraction prototype applied to the Zod (v4) TypeScript library.

---

## Corpus

All numbers in the 2026-08-26 update below were measured against
**colinhacks/zod at commit `e516c3b`**, 132 non-test source files under
`packages/zod/src`. Nothing in this repository recorded that commit until now,
which made every figure unreproducible: the original run used a `v4` tag that
no longer exists upstream, and upstream has since force-pushed `main` so
`e516c3b` is not an ancestor of it. `prototype/zod-repo/` is gitignored, so a
fresh clone does not reproduce the corpus either.

## Update (2026-10-09b): why blast radius was shallow

The blast-radius query — transitive callers of a function, the use case this
project exists to serve — returned **1** transitive caller for `parse` in
`v4/classic/parse.ts` and **4** for `_parse`, against a fact base of 16,000+
declarations at 97% closure. Four parallel investigations, each given one
hypothesis and told not to assume it.

The answer is four distinct causes at three different layers. Two were defects
and are fixed; one is a corpus property; one is a genuine wall.

### Cause 1 (defect, fixed): calls in initializers were attributed to the module

```ts
export const parse = core._parse(ZodRealError);   // classic/parse.ts:13
```

`callSite()` walked up for a *callable* container. A `VariableDeclaration` is
not callable, so the call fell through to the module id. Nothing calls a
module, so every value-flow chain through a top-level initializer dead-ended
there — and **1,543 of 5,329 call facts (29%)** were attributed that way.

Fixed by falling back to the declaration whose initializer the node sits in.
Module-attributed calls: **1,543 → 192**.

### Cause 2 (defect, fixed): the query seeded on bare names

`analyze2.ts` seeded on `d.name === "parse"`, which matches only module-level
`parse` variables. `ZodType.parse` never matched. **90 of the 101 inbound call
facts in the parse family sat on entities the query never seeded**, and
`ZodType.parse` alone holds 53 of them. `analyze.ts` was worse: it also required
`entityType === "function"`, so only `core/parse.ts:_parse` survived and the
classic entry point was never reported at all.

The traversal itself was correct — an independent BFS matched it on all 56
entities, 0 mismatches. The bug was entirely in seed selection.

| entity | before | after |
|---|---|---|
| `ts:v3/types.ts:ZodType._parse` | never seeded | **38** |
| `ts:v3/types.ts:ZodType.safeParse` | never seeded | 12 |
| `ts:v3/types.ts:ZodType.parse` | never seeded | 8 |
| `ts:v4/core/parse.ts:_parse` | 4 | **14** |

### Cause 3 (corpus): the public API's callers are all in excluded tests

| pattern | included (132 files) | excluded (189 test files) |
|---|---|---|
| `.parse(` | 66 | **3,565** |
| `.safeParse(` | 12 | 1,174 |
| `._parse(` | 19 | 0 |

Of the 66 included `.parse(`, 51 are in `v3/benchmarks/` and 6 are
`JSON.parse`. **Non-test source under `v4/classic` contains zero
`schema.parse()` call sites.** The entire caller population of the public
method lives in the 88 test files the extractor excludes by design — which is
why the 53 `ZodType.parse` edges are all v3 benchmark call sites.

This is not a defect. It is a statement about what the corpus can demonstrate.

### Cause 4 (genuine wall): the public method is installed at runtime

`parse` is not a class method. The full chain for `z.string().parse("x")` is 15
hops; the relevant ones:

```ts
// classic/schemas.ts:176
_installLazyProps(inst, "parse", _zodTypeParseProps);

// core/util.ts — installLazyProps
const built = props();                      // calls through a PARAMETER
for (const key in built) {
  defineCached(proto, key, built[key]);     // property name is a runtime string
}
```

Two indirections, with different consequences:

- `props()` resolves to **`ts:v4/core/util.ts:installLazyProps.props`** — the
  parameter — at confidence 0.9. The edge is closed, the invariant passes, and
  it leads nowhere, because a parameter has no body. The real target
  `_zodTypeParseProps` is connected only by a `references` fact at the argument
  site.
- `defineCached(proto, key, …)` under `for (const key in built)` means
  `inst.parse` ← `built.parse` has **no syntactic form naming `parse` at all**.

And the final dispatch, `schema._zod.run(...)` at `core/parse.ts:25`, goes
through a **mutable per-instance data field**: 47 writes to `_zod.parse`, 8 to
`_zod.run`. A runtime probe confirmed `z.string()._zod.run === z.string()._zod.parse`.
The possible targets are every function ever stored into that field.

**This is thesis §5.1's dynamic-language wall, and for the public API it is
real.** `ts:v4/classic/parse.ts:parse` still returns 1 transitive caller after
both defects are fixed, and that 1 is correct: its only caller is the
`_zodTypeParseProps` wrapper, which nothing connects to `ZodType.parse`.
Static-only extraction cannot serve blast radius for Zod's public entry points.
Hops 2–12 are recoverable in principle with points-to analysis; the `_zod.run`
hop is not.

### What it was *not*: virtual dispatch over the type hierarchy

The initial suspicion was unmodelled method override. Measured and refuted:

- Override-aware traversal (ascending and descending the heritage hierarchy)
  adds **16 implementation nodes and zero new callers** for
  `ZodType._parse`, and nothing at all for `core/parse.ts:_parse`.
- Only **21 of 5,169 resolved call edges (0.41%)** target a member that has a
  same-named member on a related type. Virtual dispatch is a rounding error in
  this corpus.
- **Zod v4 declares no class inheritance among schema types.** `_parse` does
  not appear in v4's core or classic schemas at all (0 occurrences); the
  implementations are `inst._zod.parse` assignments. The 36 `_parse` overrides
  are all v3.
- Of the 666 `extends` facts, child entityType splits interface 334, class 43,
  **variable 289** — the last being the cross-space declaration merge surfacing
  in heritage data.

So Zod's type hierarchy and its runtime dispatch structure are **disjoint**.
The fact base models the former; the behaviour lives in the latter.

### A category the schema does not model

`props()` produces a resolved, closed, confidence-0.9 call edge that terminates
at a parameter — an entity with no body. Closure is satisfied; the edge is
useless. ADR-0001 says closure "proves endpoints exist, not that edges are
right"; this is the concrete instance, and it suggests a third invariant worth
considering: a call edge should terminate at an entity that can execute, or be
marked as higher-order indirection.

---

## Update (2026-10-09): identity, references, and version history

Three experiments. The headline: **content-addressed identity, which thesis.md
§4.4 calls the foundation of everything else, does not survive contact with
this corpus** — and the reason is not the one §4.4 anticipates.

### 1. Content addressing collides

Two content-addressed schemes were added alongside the existing path-and-name
`entityId`, as extra fields on declaration facts:

- `structureId` — hash of the AST structure only, with the entity's own name
  masked and the path excluded. The literal reading of §4.4.
- `contentId` — hash of (declared name + AST structure), path excluded.

| scheme | distinct ids | colliding ids | entities sharing an id | worst cluster |
|---|---|---|---|---|
| `entityId` | 9,497 | 710 (7.5%) | 1,520 (14.7%) | 4x |
| `contentId` | 9,792 | 818 (8.4%) | 3,542 (35.5%) | 62x |
| `structureId` | 8,035 | 1,042 (13.0%) | **5,523 (55.3%)** | **256x** |

The 256x cluster is one `structureId` shared by 256 parameters across 82 files
under 96 different names (`iss`, `ctx`, `result`). `structureId` also merges
`ZodInt`, `ZodFloat32`, `ZodFloat64` and `ZodInt32` — four distinct exported
types with identical bodies — into a single id.

Two caveats on that table, both pushing the same way:

- The 710 `entityId` collisions split 272 cross-declaration-space (genuine
  TypeScript merges, 247 of them the `interface X` + `const X` pattern) and
  438 within value space. **The 438 have since been fixed** by lexical scope
  qualification — see the section below — leaving 20. The table's `entityId`
  row predates that fix.
- The comparison is **biased in `entityId`'s favour**. Collision is measured
  against (file, name, entityType) as ground truth, which is close to what
  `entityId` encodes, so `entityId`'s own conflation is undercounted. 974
  entity keys carry more than one content id — overloads and merged
  declarations that `entityId` silently merges and the content schemes
  correctly separate.
- The content schemes' zero multi-type collisions come from **hashing the
  declaration kind**, not from content addressing as such. The same gain is
  available to a path-based id by splitting on declaration space.

Where content addressing holds up: exported classes and interfaces. Zero
`contentId` collisions on classes, 17 of 622 interfaces.

### 2. What zod's history actually does

A harness (`history.ts`) extracts fact bases across git history and classifies
entity-level change with an oracle independent of any id scheme — matching on a
normalized body fingerprint that excludes name and path. 389 commits extracted,
297 adjacent pairs scored, every src-touching commit on first-parent history.

| Category | Entities | Commits containing it |
|---|---|---|
| unchanged | 2,182,900 obs. | 297 |
| **body edit** | **1,981** | **244** |
| rename | 51 | **1 event** |
| move | **0** | 0 |
| rename + move | 0 | 0 |

**This is the measured result, and it reframes the question.** Zod has zero
clean unedited moves and essentially one rename event — commit `d3355f7`,
`Nouns` to `FormatDictionary`, applied mechanically across 51 locale files, so
n=1 commit rather than 51 independent observations. Body edits are the
overwhelming change mode: a scheme that breaks on body edits loses identity
roughly 40x more often here than one that breaks on renames.

Note that git's own rename detection finds **zero file-level renames across all
298 src-touching commits**, which is why the oracle had to work at entity level.

### 3. Survival, and what is definitional in it

| scheme | unchanged | body edit | rename (n=1 event) |
|---|---|---|---|
| `entityId` | 100% | **100%** | **0%** |
| `structureId` | 100% | **0%** | **100%** |
| `contentId` | 100% | **0%** | **0%** |

**Most of this table is true by construction, not by measurement.** The oracle's
fingerprint and `structureId` are near-identical functions — both a depth-first
AST walk over syntax kinds plus identifier text, with the entity's own name
masked and the path excluded. The oracle *defines* a rename as "same
fingerprint, different name", so `structureId` surviving renames is a tautology,
as is its breaking on body edits. `entityId` is path+name and the oracle's first
stage pairs on path+name, so its 100% on unchanged and body-edit rows is also
definitional. Reported for completeness, not as evidence.

`contentId` is **strictly dominated**: it hashes the name, so renames break it,
and it hashes the body, so edits break it. It survives only moves, of which this
corpus has none.

### 4. The non-definitional result: content hashes assert false identity

The survival columns are tautological. These two are not.

**False continuity.** In the rename commit, 95 of 153 removed entities have
their `structureId` still present in the child commit, attached to a
*different* entity. Counted as distinct events that is **49**, cluster sizes
`[47, 1, 1, 1, ...]`: one mass event — 47 locale copies of an identical helper,
deduplicated into `core/util.ts` — plus 48 independent singletons. The raw
percentage is inflated by that cluster, the same n=1-as-n=47 trap as the rename
count, so **48 independent events** is the honest figure. A consumer tracking
entities by content hash would conclude those entities still exist.

**Aliasing on edit.** Of 108 body edits in the 24-pair sample, **7 (6.5%) gave
the edited entity a `structureId` that collides with an unrelated entity**
(`contentId`: 6, 5.6%). So on a body edit a content hash does not merely lose
identity — in about one case in sixteen it silently reassigns that identity to
something else.

This is the 55% collision rate reappearing across versions — not evidence
independent of it, but the form in which the cost is actually paid. A lost id
is a visible failure: the consumer sees an entity disappear and can fall back.
A **wrongly reused id is silent**, and every downstream consumer inherits it.

### 5. Reference facts, and the fourth artifact in one heuristic

`references` facts were added for identifier occurrences not already covered by
`calls` or `instantiates`, reusing `idOfNode()` and `resolveEntity()` so
closure holds by construction. 9,284 facts, 9,213 closed; the integrity check
was verified to bite (disabling the type-parameter skip yields 1,817 violations
and exit 1).

**7,206 of 9,284 are type-position references** — the type graph is 3.7x the
value graph by reference count, in a library whose entire purpose is types.

Fact base 26,732 to 40,737 facts (+52%); `facts.json` 5.26 MB to 8.17 MB.
Emitting function-local references too would give 48,968 facts and 12.1 MB, so
they are skipped by default: 58% of all occurrences are locals that never leave
their function. Growth is linear in LOC (~1.2 facts per line, from ~0.9), so
thesis §5.4's "millions of facts for a large monorepo" still holds.

The accidental-dependency residue decomposed as follows, and the conclusion
recorded in the 2026-08-26 section below — that the residue was largely genuine
signal — **was wrong**:

| Part of the 113 | Count | What it was |
|---|---|---|
| Extractor bug | **86** | `mkImport` hardcoded `importType: "namespace"`, ignoring `isTypeOnly()`, and ignored the per-specifier `type` in `import { type X, Y }`. 94 such statements in the corpus. Two-line fix. |
| Genuinely needed reference facts | 15 | imports used as values, never called |
| Identity-layer gaps | 12 | 11 anonymous `export default` (no entity id) plus `out_of_scope` `Mocker` |
| **Genuinely unused imports** | **0** | |

Current rate: **12 of 148 (8.1%)**, from 27 of 148 (18.2%) on calls alone. The
old 113/240 reproduces only at `55f28bf`, and the stage row "exclude type-only
imports: 138/240" below was under-excluding.

That is the **fourth** artifact found in this single heuristic, after the
key-namespace mismatch, barrel indirection, and dropped module-level callers.
Each previous diagnosis — including the one in the 2026-08-26 section —
attributed the residue to something real about static analysis. None of them
were.

### 6. Lexical scope qualification

The 438 within-value-space collisions were diagnosed in ADR-0001 as
`ownerName()` returning null inside anonymous literals. Bucketing the
contributing declarations by naming mechanism showed otherwise:

| mechanism | declarations |
|---|---|
| parameter | 2,103 |
| object-literal property | 1,217 |
| function-local variable | 560 |
| literal member, no owner | 304 |
| named-owner member colliding with an unqualified twin | 294 |
| binding element | 93 |
| literal member, **wrong** owner | 61 |

The scheme had no notion of lexical scope. `ownerName()` consulted only classes
and interfaces, and only the nearest one — so object-literal members got a bare
name, nested type-literal members inherited the enclosing interface's name
(`interface Foo { x: { y: T } }` yielding `Foo.y`, colliding with a real
`Foo.y`), and parameters, bindings and locals were never qualified at all.
Anything below top level collided by name within its file.

Ids now carry a scope path. Three further fixes came out of chasing the
residual:

| step | within-space collisions |
|---|---|
| baseline | 438 |
| drop `ShorthandPropertyAssignment` as a declaration (`{ shape }` is a reference to an existing binding, not a new entity) | 318 |
| scope path from all enclosing named constructs | 163 |
| positional segment for unbound type and object literals (a return-type annotation otherwise shares the method's scope with its locals) | **20** |

20 of 15,822 ids (0.13%). Inspecting all 20 rather than assuming: the residual
is **not** a block-scope problem.

| cause | count |
|---|---|
| overload signature parameter vs implementation local | 14 |
| type-literal `PropertySignature` classified as value space | 2 |
| nested arrow functions sharing a positional segment | 4 |

`function tuple(items, params?): T;` is an overload signature — no body, so its
`params` is a type-level annotation, not a runtime binding — while the
implementation declares `const params`. Both land on `tuple.params`. The first
two causes are defects with clear fixes rather than a ceiling.

Anonymous default exports also get ids now: `export default function () {}` and
`export default {...}` previously had no name and so no entity. 80 entities
identified. This was expected to clear the 12 remaining flagged imports and did
not — they are used via `datetimeBenchmarks.suites`, a field read on a
non-namespace, which the reference pass excludes by design. A different schema
gap than the one predicted.

Closure is unchanged throughout (5,707/5,886 and 9,213/9,284, integrity OK),
because declaration emission and resolution both route through `idOfNode()`:
changing the id format moves both ends together. Declarations rose 12,840 to
16,547 as scope qualification separated entities previously merged by name.

The ambiguity check is now split by declaration space — 267 cross-space merges
reported as expected, 20 within-space as genuine — so it no longer counts
correct declaration merges as defects.

### Caveats

- One corpus, one language, one library. Zod is type-heavy and does not move
  files; a service codebase would almost certainly show moves.
- The rename direction rests on a single commit. The move direction has no data.
- Rename-or-move combined with a body edit is invisible to the oracle: it lands
  in removed-plus-added. Bounded at 383 removed entities, of which 58
  non-member candidates were hand-inspected; one clear case (`dfd8766`, ISO
  schemas moved with small edits).
- The heuristic remains module-granular: "0 unused imports" says nothing about
  unused specifiers inside a used module.

---

## Update (2026-08-26): referential integrity

**The 96.6% figure below measures the wrong thing.** It measures whether
`getDefinitions()` landed somewhere. It does not measure whether the endpoint
it landed on names an entity the fact base declares. Measuring that instead:

| Metric | Value |
|---|---|
| Call edges with both endpoints declared | 735 / 4,385 = **16.8%** |

Both numbers were true of the same fact base. Resolving an edge to an
identifier nothing declares is worse than leaving it unresolved: the edge
carries confidence 0.8–0.9 and is unusable. Three causes, all in the identity
layer:

| Cause | Edges affected |
|---|---|
| Caller ids synthesized as `anon_<line>` / `toplevel_<line>`, backed by no declaration | 3,025 |
| Dependency paths forced through the `ts:` namespace (`ts:../../../../node_modules/typescript/lib/lib.es5.d.ts:isArray`) | 1,303 |
| Declaration coverage stopped at top-level classes/interfaces/functions/type-aliases, so methods, constructors, accessors, nested functions, arrow-bound consts, callback parameters and object-literal members were never declared | 1,033 |
| Callee id built from a different file than its declaration | 135 |

These four sum to 5,496 against 3,650 non-closed edges, because the count is
per *endpoint*: an edge with a synthesized caller and an undeclared callee is
counted in two rows.

### What changed

`idOfNode()` is now the single source of entity ids; declaration emission and
call resolution both route through it, so an endpoint is closed by
construction rather than by two code paths agreeing on a string format.
Dependency entities live in an `external:<origin>:<name>` namespace and are
declared on first reference. Members are qualified by owner
(`ZodString._parse`), because a bare method name is not unique within a
module. Call sites with no callable ancestor are attributed to the module,
which is now a declared entity. `calls` facts carry file and line per
thesis.md §4.1 — deduplication had been silently collapsing repeat calls from
one named function to one callee, and the line-numbered synthesized caller ids
were accidentally masking it (944 call sites recovered).

`new X()` parses as a NewExpression, not a CallExpression, and was producing
no fact of any kind. Added as `instantiates`.

**The invariant is now asserted at the end of every extraction run, and the
run exits non-zero when it fails.** Verified by deliberately dropping method
declarations: 21 violations reported, exit 1. This is the first mechanically
checkable answer to decisions.md open tension #3.

| Metric | Before | After |
|---|---|---|
| Declarations | 2,363 | 10,279 |
| Call facts | 4,385 | 5,329 |
| Instantiation facts | 0 | 557 |
| Resolved calls | 4,236 | 5,169 |
| **Closed edges (calls + instantiations)** | **735 (16.8%)** | **5,707 (97.0%)** |
| Dangling endpoints | 3,650 | **0** |

The residual 3.0% are honestly unresolved at confidence 0.3 — dynamic dispatch
the extractor cannot see. That is the uncertainty thesis.md asks to be
modelled rather than hidden.

### The "accidental dependency" finding was an artifact

§3.2 below reports that all 295 import edges had zero call evidence, and
attributes it to the method-call resolution gap. The 2026-08-21 correction
kept it open as a separate real gap. Neither diagnosis was right. The
heuristic compared two key namespaces:

```
modImports  keyed by bare file path   "v3/types.ts"
modCalls    keyed by module id        "module:v3/types.ts"
```

Every lookup missed, so every import edge was flagged regardless of how well
calls resolved. A heuristic that reports 100% of its input is measuring
itself. Fixing that and four further defects:

| Fix | Rate |
|---|---|
| (baseline) | 345/345 = 100% |
| Normalise module id namespace | 227/330 |
| Exclude type-only imports — 24% of import facts, and `importType` has carried the distinction since the first run; nothing read it | 138/240 = 57.5% |
| Count `new X()` as usage evidence | 134/240 = 55.8% |
| Expand import targets through re-export closure (barrel indirection: the import names index.ts, the resolved call names core.ts) | 119/240 = 49.6% |
| Map module ids to themselves, recovering 1,603 module-attributed calls (30% of all call facts) that were dropped from every module-level analysis | **113/240 = 47.1%** |

report.md recommendation #5 ("add `imports_type` as a separate fact") asks for
extractor work that was never needed — the field already existed.

The remaining 113 are largely not false positives. They are imports used as
values rather than called: `defaultErrorMap` assigned into a config, benchmark
objects pushed into an array. The heuristic asks "is this import called?" and
reports the answer as "is this import used?" Answering the second needs
reference facts — every identifier occurrence resolved to its declaration —
which the fact base does not model. **That is a schema question for ADR-0001,
not more tuning.**

### A second integrity property, and it does not hold

Referential closure asks whether an endpoint is declared. It does not ask
whether an entity id names exactly one entity. Measuring that:

```
Ambiguous entity ids (one id, multiple entityTypes): 710 of 9,467 (7.5%)
  ts:v4/core/core.ts:output        -> type, property
  ts:v4/core/registries.ts:$output -> variable, type
  ts:v4/classic/in-out.ts:input    -> function, type
```

Two different causes are tangled here. TypeScript declaration merging — a
`const` and a `type` of the same name — is one entity in two halves, and
arguably should share an id. A type alias and a class property both named
`output` in one module are two entities that collide on one id, which is a
defect. `idOfNode()` cannot currently tell them apart.

This is reported by the extractor, not enforced. Which case the schema should
tolerate is precisely the symbol-identity question thesis.md §4.4 leaves open,
and it now has a number attached: **owner qualification fixed intra-file
collisions between class members; it did not fix collisions across
declaration spaces.**

Relatedly, `out_of_scope` has exactly one instance — `Mocker`, reached because
resolution escaped the `tests/` file filter. One instance, but it poses a real
scope-boundary question for ADR-0001: does the fact base model only what it
walked, or everything it can reach?

The 32 entities previously reported as entityType "unknown" were an
unaudited fallback in the extractor's own type classifier. They are 14
namespace re-exports (which the export map yields as SourceFile nodes), 10
TypeScript `namespace` declarations, and 8 object literals. The fallback now
names the syntax kind rather than discarding it.

### Also fixed

`getToken()` returns a SyntaxKind enum value, not a node, so the original
`h.getToken()?.getText?.() === "implements"` was permanently false — and
neither of the two booleans it computed was ever read. Every heritage clause
was emitted as `extends`, and heritage extraction ran only on exported
declarations. Now 663 extends + 1 implements. The bug was three real defects, but note the
evidence for the `implements` half is n=1: `ParseInputLazyPath` in
`v3/types.ts` is the only `implements` clause in this corpus.

`resolveImport` returned the raw specifier for bare package names, which the
caller ran through `rel()`, turning `zod/v3` into the import edge
`../../../../zod/v3`. It now returns null, making the `external:` fallback
that had always been there reachable.

---

## Correction (2026-08-21)

**§3.1 and §6's "FATAL" method-call finding was a bug in the extractor, not a limitation of static analysis.**

The original extractor (`extract.ts`) only resolved calls where `call.getExpression()` was a plain `Identifier`. Method calls (`obj.method()`) produce a `PropertyAccessExpression` instead, which hit no resolution branch at all — `calleeId` was never even attempted, not attempted-and-failed. The 0% method resolution rate reported below is an artifact of unwired code, not evidence that method dispatch is unresolvable without a custom type-based receiver resolver.

**The fix is 10 lines**, using the same ts-morph language-service call already used for identifiers, applied to the property-access name node instead:

```ts
} else if (Node.isPropertyAccessExpression(expr)) {
  const nameNode = expr.getNameNode();
  const defs = nameNode.getDefinitions();
  // ... same resolution as the identifier branch
}
```

Rerun against a fresh clone of Zod (main branch, 132 source files — the `v4` tag used originally no longer exists upstream, so file counts differ from the original run):

| Metric | Original report | Corrected |
|---|---|---|
| Total calls | 3,784 | 4,385 |
| Function calls resolved | 629 / 629 (99%) | 923 / 929 (99%) |
| **Method calls resolved** | **0 / 3,149 (0%)** | **3,313 / 3,456 (95.9%)** |
| **Overall call resolution** | **16.6%** | **96.6%** |

Blast-radius tracing — the exact use case §3.3 said was impossible — now works: `_parse` in `v4/core/parse.ts` resolves 8 transitive callers including `_decode`, `_encode`, and call sites in `classic/parse.ts` and `mini/schemas.ts`.

**What still stands from the original report:** the "accidental dependency" and "unused import" heuristics (§2.2/§5 in the analysis output) still flag hundreds of imports with no call evidence even at 96.6% call resolution — that's a separate, real gap (likely type-only imports and instantiation via `new`, not call-graph incompleteness) worth investigating on its own, not evidence against the fact-based approach.

**Revised bottom line:** the fact-based approach is not merely "sound but incomplete" — the corrected prototype answers the core blast-radius question this project exists to answer, using nothing but the TypeScript compiler's existing symbol resolution. No custom type checker, no `calls_method` schema split, no runtime tracing needed to hit >95% resolution on a real, method-heavy codebase. The schema distinction between resolved/unresolved calls (via `confidence`) is still useful, but was never blocking.

The rest of this document is preserved as originally written, for the record.

**Reading note.** The preserved body below was written against a 116-file run
of an extractor with known defects, and the corrections above reverse several
of its conclusions without editing them in place. Specifically, in the body:

- §3.1's "(FATAL)" heading and its 0% method resolution are an extractor bug,
  not a finding. §5's "3,149 (83%)" is likewise the bug's footprint.
- §6's "Atlas can analyze 100%" and §8's "the call graph doesn't, because 83%
  of calls are method dispatches" are both superseded. Measured closure is
  97.0% with zero dangling endpoints, and 179 edges remain honestly
  unresolved — not 0.
- §7 #7's "the symbol identity layer is working but fragile" understates it.
  710 of 9,467 ids (7.5%) are ambiguous, and identity is the project's
  highest-risk open assumption.
- §4.1's "only 32 of 2,161 declarations couldn't be classified" is not a
  classification rate. The 2,161 omitted whole declaration classes, and the 32
  were an unaudited fallback. Declarations are now 10,279.
- §4.3's and §6's "99% accuracy" measure how often `getDefinitions()` returned
  something, not whether it returned the right thing. Correctness has never
  been measured.
- §5's "import type semantics lost (~40%)" is wrong in both directions: the
  share is 24%, and the distinction was never lost — `importType` carried it
  from the first run and nothing read it.
- §5's "arrow function naming ~50% anonymous" and "external packages: all
  unresolvable" are both fixed. §2.1's hub counts and all body fact counts are
  from the 116-file run; the corpus is now 132 files.
- §3.2's "295 import edges" and the corrected baseline of 345 are never
  reconciled. 345 is the correct figure for this corpus.
- §4.2's "Variables (464) == functions (595)" is internally inconsistent as
  written.

---

- **Target**: colinhacks/zod v4, 116 source files (non-test), ~30k LOC TypeScript
- **Extractor**: 300-line ts-morph script emitting typed facts
- **Analysis**: Facts queried via Node.js scripts for architectural reasoning

---

## 1. What the Prototype Extracted

**9,095 unique facts** from 116 files in ~10 seconds.

| Fact Type | Count | Notes |
|---|---|---|
| `declaration` | 2,161 | functions (595), interfaces (598), variables (464), types (419), classes (51) |
| `contains` | 1,899 | module-entity containment pairs |
| `calls` | 3,784 | call expressions with confidence scores |
| `import` | 367 | named, default, and namespace imports |
| `reexport` | 235 | `export * from` and `export { x } from` edges |
| `extends` | 649 | class/interface heritage edges |

The fact model worked. Typed, provenance-tracked facts from ts-morph are efficient and queryable. The 300-line extractor is production-unfit but fully validates the approach.

---

## 2. What the Facts Could Answer

### 2.1 Architectural Boundaries (import coupling)

The import graph alone reveals the structural skeleton of the codebase.

**Dependency hubs** (highest fan-in):

```
v4/core/util.ts       imported by 60 modules
v4/core/errors.ts     imported by 59 modules
v4/core/checks.ts     imported by 55 modules
v4/core/index.ts      imported by 11 modules
v4/core/schemas.ts    imported by 10 modules
```

This aligns with the actual architecture: `util`, `errors`, and `checks` are the shared foundation layer that everything else depends on. The system correctly identified these without any human annotation.

**Highest fan-out** (modules importing many others):

```
v4/core/schemas.ts    imports 12 modules
v3/types.ts           imports 9 modules
v4/core/api.ts        imports 6 modules
```

`schemas.ts` and `api.ts` are the top-level integration points — they compose many lower modules. This pattern correctly suggests they are the most complex and change-sensitive files.

**Bidirectional imports**: 26 mutual import pairs. These are potential architecture violations — modules that import each other suggest a coupling that should be examined.

### 2.2 Layer Boundary Detection

The prototype detected the clear architectural layer: `v4/classic` depends on `v4/core` (13 import edges from classic → core, 0 in reverse). This is the intended architecture — `classic` is the v3-compatibility layer built on top of `v4/core` primitives.

### 2.3 Barrel File Detection

20 files are re-export hubs. 11 are pure barrels (no own declarations) — these files exist only to re-export from other modules. Atlas can automatically flag barrel files as architectural noise that inflates the import graph.

### 2.4 Pattern Detection

54 locale files export the same shape (a function returning `{ localeError }`). The prototype identified this as a template pattern: structurally identical files with different data. This is relevant for codebase understanding — a human reading the codebase should know that these 54 files are all variants of the same pattern, not 54 unique modules.

---

## 3. What the Facts Could NOT Answer

### 3.1 Method Call Resolution (FATAL)

**83% of all call expressions are object method calls** (`this._parse`, `util.stringifyPrimitive`, `Array.isArray`), and the prototype could not resolve any of them.

Breakdown:
- 629 simple function calls → 99% resolved
- 3,149 method calls → 0% resolved
- 6 other → mixed

This means the overall call graph resolution rate is 16.6%, not because the resolution algorithm is wrong, but because the codebase's dominant call pattern is OOP method dispatch, not top-level function calls. Even in a library that's relatively functional in style, the call graph is primarily a method graph.

**What this means for Atlas:** A "call graph" that only resolves top-level function calls is not a call graph — it's a skeleton. Without inter-procedural type analysis, interface resolution, and class hierarchy traversal, you cannot answer:

- "What is the blast radius of changing a method signature?"
- "Which callers pass through this pipeline?"
- "Which implementations of this interface exist?"

### 3.2 "Accidental" Dependency Detection

All 295 import edges had zero resolved call evidence — falsely flagging every import as potentially accidental. This is a direct consequence of the method call resolution gap: the imports ARE used, but the usage happens through method dispatch that the extractor can't see. False positives make this analysis useless.

### 3.3 Transitive Caller Analysis

Of 26 functions named `parse`/`safeParse`/`_parse`, only 3 had any resolved callers, and those callers were anonymous lambdas or arrow functions. The system could not trace the call chain from entry point to implementation, which is the core blast-radius use case.

---

## 4. Surprising Discoveries

### 4.1 The "Unknown" Declaration Rate Is Trivial

Only 32 of 2,161 declarations (1.5%) couldn't be classified. The standard TypeScript declaration kinds cover nearly everything.

### 4.2 Variable Declarations Are the Dominant Declaration Form

Variables (464) == functions (595) in count, because TypeScript code heavily uses `const x = (): Type => { ... }` arrow function style rather than `function x()` syntax. This has implications for entity naming — arrow functions assigned to variables are the idiom, and Atlas's entity model must treat them as first-class functions.

### 4.3 ts-morph's Symbol Resolution Is Excellent for Simple Cases

When the call target is an identifier, `getDefinitions()` resolves it correctly 99% of the time. The compiler API already does the hard work of cross-file name resolution. Atlas doesn't need to reimplement a type checker — it needs to integrate with the compiler's symbol table and extend it to object-property resolution.

### 4.4 Import Structure Alone Provides Useful Architectural Signal

Even without a call graph, the import graph correctly identified:
- Dependency hubs (`util`, `errors`, `checks`)
- Integration points (`schemas.ts`, `api.ts`)
- Architectural layers (`v4/classic` → `v4/core`)
- Pattern-repeated modules (54 locale files)

This means the "V1: static structural only" scope is viable. The import graph alone answers some architectural questions. But the call graph is needed for blast-radius and coupling analysis.

---

## 5. Complete Failure Catalog

| Failure | Count | Impact | Remedy |
|---|---|---|---|
| Method calls unresolved | 3,149 (83%) | Call graph is near-useless | Type-based receiver resolution |
| `import type` semantics lost | ~40% of imports | Type-only vs value imports conflated | Track import type separately |
| External packages | All unresolvable | Cross-repo analysis impossible | npm registry index or package.json parsing |
| Arrow function naming | ~50% of callers anonymous | Caller identity lost for arrow-heavy code | Variable binding association |
| Decorated entities | Not extracted | Angular/NestJS patterns invisible | Decorator AST extraction |
| Anonymous class instantiations | Not identified | Classes created via `new class { }` missed | Detect anonymous class expressions |
| Template literal types | Invisible | `z.infer<typeof schema>` not modeled | Generic instantiation tracing |
| Dynamic `import()` | Not extracted | Lazy-loaded modules invisible | Runtime trace data needed |
| `eval()` / code generation | Not extracted | Any generated code is invisible | Runtime trace data needed |

---

## 6. Technical Verdict

**Should Atlas continue in this direction?**

**Yes, with a critical amendment to the fact model.**

The fact-based approach is validated. Typed, provenance-tracked facts from the TypeScript compiler API are queryable, efficient, and answer real architectural questions. The import graph alone provides useful signal.

However, the **"call" fact type is wrong.** A single `calls` fact cannot capture the dominant call pattern in modern TypeScript — object method dispatch. The corrected fact model needs:

```
calls_function    — callerId calls calleeId (resolved, 99% accuracy)
calls_method      — callerId calls METHOD on RECEIVER of TYPE (unresolved without type info)
calls_constructor — callerId instantiates CLASS
```

This distinction is not an implementation detail — it's a fundamental schema decision. Without method call resolution, Atlas can analyze ~17% of the codebase's actual call structure. With it, Atlas can analyze 100%.

The path forward is clear: build a method call resolver that queries the TypeScript compiler's type checker for the receiver type, resolves the method to its declaration, and emits `calls_method` facts with full type information. This is not a V2 feature — it's a V1 requirement for the call graph to be useful.

---

## 7. Recommendations

1. **Continue the fact-based approach.** It works. Skip the universal graph model design.

2. **Add method call resolution immediately.** Without it, the call graph answers nothing. Use `ts-morph`'s `TypeChecker` for receiver type resolution — the infrastructure exists, it just needs wiring.

3. **Start with import-only analysis for V1.** Even the basic import graph correctly identifies dependency hubs, architecture layers, and pattern-repeated modules. This is useful output that could ship tomorrow.

4. **Treat barrel files as a first-class concern.** They inflate the import graph and create entity identity confusion. Atlas should detect them, collapse their edges, and trace through to the source declarations.

5. **Add `imports_type` as a separate fact from `imports_value`.** Type-level imports create architectural dependencies that are semantically different from runtime imports. Conflating them loses information.

6. **Accept that runtime data will be needed.** `this._parse()` will always be ambiguous in the presence of subclasses, mixins, and prototype manipulation. Only runtime profiling provides ground truth. Plan for a trace ingestion pipeline.

7. **The symbol identity layer is working but fragile.** Content-addressed or path-based IDs both have problems. The current approach (ts:filepath:name) is functional but breaks on renaming. This needs deeper design.

---

## 8. Bottom Line

The prototype demonstrated that fact extraction from TypeScript source code answers real architectural questions — but only partially. The import graph works. The call graph doesn't, because 83% of calls are method dispatches that require type information. This is not a fundamental flaw in Atlas — it's a missing fact type in the schema. Fix that, and the approach is sound.
