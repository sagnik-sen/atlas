# Atlas Prototype Report

Analysis of whether Atlas's core hypothesis is true, based on a throwaway fact extraction prototype applied to the Zod (v4) TypeScript library.

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

### Also fixed

`getToken()` returns a SyntaxKind enum value, not a node, so the original
`h.getToken()?.getText?.() === "implements"` was permanently false — and
neither of the two booleans it computed was ever read. Every heritage clause
was emitted as `extends`, and heritage extraction ran only on exported
declarations. Now 663 extends + 1 implements, the latter being the only
`implements` clause in the corpus and previously invisible.

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
