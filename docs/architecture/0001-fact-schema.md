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

The failure mode is how that cost is paid. In the one rename commit, 95 of 153
removed entities have their hash still present in the next commit attached to a
different entity — **49 distinct events**, one of which (47 locale copies of an
identical helper) accounts for 47 of the 95. So 48 independent false-continuity
events plus one mass event, not 95 independent ones. Separately, **6.5% of body
edits** (7 of 108) give the edited entity a hash that collides with an
unrelated entity. A lost id is a visible failure the consumer can fall back
from. A wrongly reused id is silent, and every downstream consumer inherits it.

§4.4's two claims cannot both hold. It says the hash is "stable across
refactoring (same hash = same entity)" and that it "captures definition
changes". A body edit therefore mints a new id, so the stability is only the
stability of an entity that has not changed.

**The change mix decides the trade.** Over 297 adjacent commit pairs: 1,981
body edits across 244 commits, one rename event, zero clean moves. A
body-sensitive id loses identity ~40x more often on this corpus than a
rename-sensitive one.

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
| Content-addressed ids (thesis §4.4) | Survives rename and move; no path coupling | 60.1% of entities in a colliding id (worse as identity gets finer: 55.3% before scope qualification); 49 distinct false-continuity events in one commit; 6.5% silent aliasing on body edits; breaks on every body edit, the dominant change mode | Fails silently on the common case to survive the rare one |
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
and path-shaped (`ZodObject._getCached.@typeliteral0.shape`). Per-occurrence references grow the fact base ~52%.

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
  project's headline use case, and it is an argument for runtime trace
  ingestion being V2 rather than optional.
- **Field reads are not modelled.** The 12 remaining flagged imports are used
  via `datetimeBenchmarks.suites` — a property read on a non-namespace, which
  the reference pass excludes because such reads dispatch on a runtime type.
  Giving anonymous default exports ids was expected to clear these and did not;
  clearing them needs a field-read edge kind, which is a schema decision this
  ADR does not make.
- **Query substrate → ADR-0002.** thesis §7.3 calls Datalog the
  highest-reward decision in the project. This ADR deliberately does not decide
  it: the fact base is defined independently of what queries it.
- **Cross-language identity.** The `ts:` prefix is a TypeScript scheme.
  decisions.md open tension #2 is untouched.
- **Correctness beyond closure, and it is not marginal.** Closure proves
  endpoints exist, not that edges are usable. Measured: **939 of 5,169 resolved
  call edges (18.2%) terminate at an entity that cannot have a body, and all
  939 carry confidence >= 0.8** — 615 at bodyless interface methods, 249 at
  interfaces, 41 at type properties, 34 at parameters. Zod declares its public
  API as bodyless interface members, so for this corpus the pattern is
  structural, not incidental.

  This was first found as a single case (`props()` resolving to a parameter)
  and recorded here as worth considering. At 18.2% it is more than that:
  closure and confidence together do not tell a consumer whether an edge is
  usable, which is a gap in the schema rather than in the extractor. The
  candidate third invariant — a call edge terminates at an entity that can
  execute, or is marked as higher-order indirection — is not adopted in this
  ADR because the right response is undecided: re-resolve through the type
  hierarchy, mark the edge, or accept it. It is reported as a diagnostic by
  `questions.ts` Q6. No oracle for edge correctness exists.
- **Incrementality.** thesis §4.2 claims it "falls out naturally". There is no
  incremental run, and the fact that any schema change invalidates every cached
  fact base suggests it will not fall out of anything by itself.

## Validation

The evidence is one corpus, one language, one library — and a type-heavy one
that never moves files. A service codebase would likely show moves, which this
corpus cannot test at all. Decision 2 is the one most exposed to that: if moves
turn out to be common elsewhere, the trade it makes is wrong, and it should be
revisited against a corpus that has them rather than defended.
