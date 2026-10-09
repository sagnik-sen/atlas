# ADR-0001: The Fact Schema

**Status:** Proposed
**Date:** 2026-10-09
**Supersedes:** The retired "ADR-0001: Graph Model Definition" milestone
**Superseded by:** None

## Context

`docs/thesis.md` establishes that Atlas's representation is a typed,
provenance-tracked fact base, and that a graph is one query lens over it rather
than the source of truth. It leaves the schema itself undefined. This ADR
defines it.

It is written against measurement, not design intuition. Every number comes
from the throwaway extractor in `prototype/`, run over the Zod library at
commit `e516c3b` (132 non-test source files, ~30k LOC TypeScript). See
`prototype/report.md`.

### What has been established

**Referential closure is the property that matters, and it is not the same as
resolution.** Resolution asks whether the compiler's symbol lookup returned
something. Closure asks whether the thing it returned names an entity the fact
base declares. The same fact base measured 96.6% on the first and **16.8%** on
the second. Resolving an edge to an identifier nothing declares is worse than
leaving it unresolved, because the edge carries confidence 0.8–0.9 and is
unusable. Closure is now 97.0% of call and instantiation edges and 9,213 of
9,284 reference edges, with zero dangling endpoints.

**Four separate "findings" about static analysis were extractor defects.** Each
was recorded as evidence about Atlas's approach; each was a bug:

| Reported as | Actually |
|---|---|
| "83% of calls are method dispatch and none resolve" (marked FATAL) | method calls hit no resolution branch at all |
| "all 295 import edges have zero call evidence" | the heuristic compared `v3/types.ts` against `module:v3/types.ts` |
| "84 unknown entities, 2120 unresolved calls" | hardcoded string literals formatted to look computed |
| "the residue is imports used as values" (113 edges) | 86 were `importType` misclassifying `import type * as` |

Separately, the accidental-dependency heuristic produced four defects of its
own in sequence — key-namespace mismatch, barrel indirection, dropped
module-level callers, `importType` misclassification — and every diagnosis
along the way attributed the residue to something real about static analysis.
None of them were. This is the central argument of this ADR: **a fact base's
consumers cannot tell a real limitation from a bug in the extractor**, and
three rounds of analysis by different authors failed to.

**Content-addressed identity does not work as primary identity here.**
thesis.md §4.4 calls it the foundation of everything else and the project's
highest-risk assumption. Tested: a structure-only hash puts **55.3% of
entities** in a colliding id, with one id covering 256 parameters across 82
files; it merges four distinct exported types with identical bodies.

The failure mode is how that cost is paid, and the full-history run (297 pairs,
389 commits) sharpens it considerably from the earlier 24-pair sample:

| measure over 297 pairs | `structureId` | `contentId` |
|---|---|---|
| aliasing on body edit, raw | 3.9% (81) | 1.5% (32) |
| ...where the old id was unique in the parent | 0.43% (9) | 0% (0) |
| removed id reappears, as distinct events | 1,428 across 100 commits | 31 across 12 |
| strict transfers (old id unique, new holder) | 891, but 888 have bodies under 12 nodes and cannot be adjudicated; **3** clear | 1 |
| unchanged observations whose id is *shared* in the child | **48%** | 20% |

The earlier "6.5% silent aliasing" was a small-sample artifact; at full scale it
is 3.9%, and most of that is an old id that was already shared rather than an
identity handed over. **The decisive row is the last one**: for half of all
unchanged observations a surviving `structureId` does not pin a single entity.
It identifies a *structure*, not an identity — the 60% collision rate
reappearing across history rather than a separate defect. A lost id is a
visible failure the consumer can fall back from. A wrongly reused id is silent,
and every downstream consumer inherits it.

§4.4's two claims cannot both hold. It says the hash is "stable across
refactoring (same hash = same entity)" and that it "captures definition
changes". A body edit therefore mints a new id, so the stability is only the
stability of an entity that has not changed.

**The change mix decides the trade.** Over all 297 adjacent commit pairs
(full run, not a sample): **2,070 body edits across 247 commits, 5 independent
rename events, zero clean moves.** A body-sensitive id loses identity roughly
400x more often on this corpus than a rename-sensitive one.

## Decision

**1. The fact base is a set of typed facts with closed endpoints.** Every fact
is a tagged record carrying `confidence`, a source location, and provenance.
Entity-referencing fields hold entity ids, never names or paths.

**2. Entity identity stays path-and-name based, and is scoped by declaration
space.** Ids keep the form `ts:<file>:<Owner.name>`, with `external:<origin>:<name>`
for dependency entities and `module:<file>` for modules. This is a deliberate
choice of the scheme that fails *visibly* on the corpus's rare change mode over
one that fails *silently* on its dominant one.

The 710 ambiguous ids need **two different fixes**, and measuring them changed
this decision. Split by TypeScript declaration space:

| | Count | Share |
|---|---|---|
| Cross-space (type vs value vs namespace) | 272 | 38% |
| **Within value space** | **438** | **62%** |

Declaration-space qualification resolves at most the 272. The 438 were not an
"anonymous literal owner" gap, as an earlier draft of this ADR claimed before
measuring. Bucketing the contributing declarations:

| mechanism | declarations |
|---|---|
| parameter | 2,103 |
| object-literal property | 1,217 |
| function-local variable | 560 |
| literal member, no owner | 304 |
| named-owner member colliding with an unqualified twin | 294 |
| binding element | 93 |
| literal member, **wrong** owner | 61 |

The id scheme had **no notion of lexical scope**. `ownerName()` consulted only
classes and interfaces, and only the nearest one, so object-literal members got
a bare name, members of a nested type literal inherited the enclosing
interface's name (`interface Foo { x: { y: T } }` → `Foo.y`, colliding with a
real `Foo.y`), and parameters, bindings and locals were never qualified. Any
non-top-level declaration collided by name within its file.

**Decided and implemented:**

- **Within one space:** ids carry a lexical scope path. Every enclosing
  construct that introduces a scope contributes a segment; the class/interface
  case is one segment type among many. Unbound type and object literals get a
  positional segment, since a return-type annotation otherwise shares the
  method's scope with its locals. `ShorthandPropertyAssignment` is not a
  declaration — `{ shape }` is a reference to an existing binding. Result:
  **438 → 20 collisions** (0.13% of 15,822 ids). Inspecting all 20: they are
  not a block-scope problem, as first assumed. 14 are **overload signatures** —
  `function tuple(items, params?): T;` declares a type-level parameter `params`
  and the implementation declares `const params`, and both land on
  `tuple.params`. An overload signature has no body, so its parameters are not
  runtime bindings and should not be entities. 2 (`DIRTY.value`, `OK.value`)
  are a space-classifier defect: a `PropertySignature` in a type literal is
  type space, but the classifier maps every `property` to value space. The rest
  are nested arrow functions sharing a positional segment.
- **Cross-space (267):** genuine TypeScript declaration merges — 247 are the
  `interface X` + `const X` pattern this corpus uses pervasively. **One
  TypeScript symbol is one entity**, so these keep one id and carry multiple
  declaration facts.
- **Anonymous `export default` gets an id.** 80 entities previously had no
  name and therefore no identity.

**3. Content hashes are facts about an entity, not its identity.** `contentId`
and `structureId` remain as fields on declaration facts, for cross-version
rename and move detection, gated on a minimum body size. They are inputs to a
matcher, never keys.

**4. Every extraction run asserts its own invariants and fails the run.** Two
are defined now:
- *Closure*: every edge endpoint names a declared entity or is explicitly
  unresolved with confidence ≤ 0.3. Enforced; exits non-zero.
- *Unambiguous identity*: one entity id names one entity, where merged
  declarations of a single TypeScript symbol count as one entity. The check is
  split by declaration space accordingly: 267 cross-space merges are reported
  as expected, and 20 within-space collisions as genuine. Reported, not yet
  enforced — enforcing requires dropping overload-signature parameters as
  entities and classifying type-literal members as type space, which together
  are most of the residual 20.

Given the four artifacts above, this is not a quality-of-implementation detail.
It is the schema's primary defence.

**5. Uncertainty is graded, and "unresolved" is a first-class outcome.** An
edge the extractor cannot resolve is emitted at confidence 0.3 with its reason,
not dropped. 179 call edges and 71 reference edges are currently in this state.

**6. Scope is what was walked, plus what it reaches, marked.** Entities reached
by resolution but outside the walked file set are declared with
`entityType: "out_of_scope"`. Dependency entities are declared as `external`.
Closure is never achieved by silently inventing an endpoint.

**7. Edge kinds are distinguished by how the language distinguishes them.**
`calls` (CallExpression), `instantiates` (NewExpression), `references`
(identifier occurrence), `extends` / `implements` (separate heritage clauses),
`import` / `reexport`, `contains`. Merging any two of these has already cost a
wrong conclusion: heritage was emitted as `extends` wholesale, and `new X()`
emitted nothing at all.

**8. References are per-occurrence; rollups are a lens concern.** File and line
are the provenance. Collapsing occurrences at extraction time destroys it.
Function-local references are excluded by default: they are 58% of all
occurrences and never leave their function.

## Alternatives Considered

| Alternative | Pros | Cons | Why rejected |
|---|---|---|---|
| Content-addressed ids (thesis §4.4) | Survives rename and move; no path coupling | 60.1% of entities in a colliding id (worse as identity gets finer: 55.3% before scope qualification); half of unchanged observations carry an id shared with another entity; 3.9% aliasing on body edits; breaks on every body edit, the dominant change mode | Fails silently on the common case to survive the rare one |
| Hybrid: content hash primary, path as tiebreak | Keeps rename survival | Collision resolution needs the path, so the id is path-coupled anyway, with a hash's opacity added | Pays the cost of both, keeps the benefit of neither |
| Compiler-assigned symbol ids (SCIP-style monikers) | Standard, tool-interoperable | Requires a resolved program; thesis §2.4 rejects a build requirement | Revisit if the build requirement is relaxed |
| Graph node/edge model (original vision) | Familiar; direct traversal | No uncertainty model; flattens temporal and intentional facts | Already rejected by thesis §3 |
| Defer the schema until lenses exist | Avoids premature commitment | The four artifacts above all came from an unspecified schema | The schema is what makes the lenses checkable |

## Consequences

**Easier.** Closure and unambiguous identity are mechanically checkable, so the
class of defect that produced four false findings now fails the build. Lenses
can assume every endpoint resolves. Content hashes are available for refactor
detection without being load-bearing.

**Harder.** Ids remain unstable under rename and move — accepted, and the cost
is visible rather than silent. Scope qualification is a breaking change to
every member and parameter id — most of the fact base — and makes ids longer
and path-shaped (`ZodObject._getCached.@typeliteral0.shape`).

**And the real instability is not what this ADR said it was.** Measured over
full history, `entityId`'s dominant failure is **positional drift, not
renames**: of 269 entities whose owner-qualified name changed, **263 (98%)
across 43 commits are a `@blockN` / `@arrowfunctionN` / `@objectliteralN` index
shifting because a sibling was inserted earlier in the file**. Only 6 were real
owner renames, against 5 rename events in the entire history. Worst commits:
`773a486` (75 entities), `3063993` (41), `6f04836` (19). It is a lower bound —
entities under 12 nodes with the same drift land in removed-plus-added instead.

That is a weakness of the *positional disambiguator* introduced with scope
qualification, not of path-based identity as such. The `shortcut:` comments on
`anonSegment` name exactly this risk; this is it, quantified. Anchoring
anonymous scopes on something order-independent (nearest named ancestor plus a
content-derived discriminator) would remove most of it, at the cost of making
part of the id content-derived. Worth revisiting; not decided here. Per-occurrence references grow the fact base ~52%.

**Unresolved, and deliberately out of scope.**
- **Runtime method installation is not modelled, and for some corpora that is
  decisive.** Zod installs its public `parse` with
  `_installLazyProps(inst, "parse", _zodTypeParseProps)`, then
  `for (const key in built) defineCached(proto, key, built[key])`, then
  dispatches through the mutable field `schema._zod.run`. No syntactic
  construct names `parse` along that path, so no fact can link the declared
  method to its implementation. Blast radius for Zod's public entry points is
  therefore unanswerable from static facts alone — not because of a defect, but
  because the information is not in the source text. See
  `prototype/report.md`'s 2026-10-09b section. This is the first measured
  instance of thesis §5.1's dynamic-language wall actually blocking the
  project's headline use case.

  **A runtime-tracing spike then tested whether traces close it, and the answer
  is "partly, and not the part that was asked".** A V8 sampling profiler with
  frames source-mapped back to entity ids captured 548 edges, of which 80 are
  genuinely new function-to-function pairs. It *does* recover the dispatch
  chain static analysis cannot see: `installLazyProps → _zodTypeParseProps`
  (which static resolves to a parameter) in 9 of 12 runs, the `defineCached`
  getter → the wrapper in 12 of 12, and the whole `_zod.run` dispatch into
  `$ZodObjectJIT`/`$ZodString`/`$ZodNumber` in 12 of 12. Callers of an
  implementation behind `_zod.run` go from 0 to a 3-hop path.

  But blast radius for the public `parse` stays **1**, for two reasons neither
  of which a better tracer fixes: `ZodType.parse` is a bodyless interface
  member, so it is never a stack frame and nothing joins it to the wrapper
  without call-site positions and the property key; and its real callers are
  user and test code that is not in the fact base at all. **Runtime ingestion
  is therefore conditional, not simply V2.** Three things must come first:
  (1) the identity layer must give ids to functions bound by property
  assignment — only 34% of runtime edges join *exactly* today, the rest falling
  back to an enclosing constructor; (2) capture must be deterministic and carry
  call-site positions, which a sampler does not; (3) the traced workload's code
  must itself be in the fact base.
- **Field reads stay unmodelled, now on evidence.** This ADR previously
  attributed the 12 remaining flagged imports to missing field-read edges.
  Measured, that was wrong twice over: only 8 of the 12 were field reads, and
  none was caused by the read — the receiver was already emitted as a
  `references` fact and came back unresolved because `getDeclarationNode()`
  returns undefined for an anonymous `export default`. Fixing that resolution
  takes the rate to **1 of 148 (0.7%)** with no field-read edges at all, and the
  survivor is the `out_of_scope` containment gap.

  Field reads were built and measured on a branch: +14% facts and +18% bytes
  (or +2% excluding function-local receivers) for **zero** marginal benefit on
  this metric. 83% of resolved field reads point at a `type-property`, so the
  real value, if any, is field-level impact queries ("who reads
  `ParsePayload.issues`") rather than import hygiene — untested. The deferral
  stands, and the `nonlocal` variant as `references` with `ctx: "field"` is the
  shape to adopt if a lens needs it.
- **Query substrate → ADR-0002.** thesis §7.3 calls Datalog the
  highest-reward decision in the project. This ADR deliberately does not decide
  it: the fact base is defined independently of what queries it.
- **Cross-language identity.** The `ts:` prefix is a TypeScript scheme.
  decisions.md open tension #2 is untouched.
- **Correctness beyond closure, and it is not marginal.** Closure proves
  endpoints exist, not that edges are usable. Measured with a per-id body test
  (a class, or any declaration with a non-null body, or a variable/property
  initialised with a function): **653 of 5,707 resolved edges (11.4%), or 15.9%
  of the 4,113 in-repo resolved edges, terminate at an entity that cannot
  execute.** A resolved edge is only ever confidence 0.8 or 0.9, so every one of
  them is high-confidence by construction — confidence carries no signal here.

  True magnitude is a range, 653 to 1,048: another 395 edges end at an id
  merging a `function` with a `type-method`, and the facts cannot say whether
  TypeScript bound the call to the signature or the implementation.

  By bucket, because the fixes differ:

  | bucket | edges | what would resolve it |
  |---|---|---|
  | signature (interface or abstract member) | 279 | class-hierarchy resolution over existing `extends`/`implements` facts |
  | value-bound (alias variable or property) | 153 | one-hop alias following |
  | factory-const (`const ZodX = core.$constructor(...)`) | 101 | linking the `$constructor` init arrow to the constant |
  | higher-order (parameter) | 120 | points-to analysis |

  Note the motivating case — `props()` resolving to a parameter — is the
  **smallest** bucket at 2.1% of resolved edges, and only 4 of its 120 edges
  are strictly recoverable from existing facts. A points-to pass is not
  justified. An earlier figure of 18.2% recorded here was an over-count: it
  blacklisted entityTypes rather than testing for a body, so it counted
  function-valued properties such as `"~standard": (self) => ...` as
  non-executable, and counted externals, which may well execute.

  Not adopted as a third invariant: a fail-on-nonzero check would fire
  permanently while the right response per bucket is still undecided. Reported
  as a diagnostic instead (`questions.ts` Q6). No oracle for edge correctness
  exists.
- **Incrementality.** thesis §4.2 claims it "falls out naturally". There is no
  incremental run, and the fact that any schema change invalidates every cached
  fact base suggests it will not fall out of anything by itself.

## Validation

The evidence is one corpus, one language, one library — and a type-heavy one
that never moves files. A service codebase would likely show moves, which this
corpus cannot test at all. Decision 2 is the one most exposed to that: if moves
turn out to be common elsewhere, the trade it makes is wrong, and it should be
revisited against a corpus that has them rather than defended.
