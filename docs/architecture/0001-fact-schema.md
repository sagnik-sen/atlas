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

Declaration-space qualification — the obvious fix, and the one this ADR first
proposed for all 710 — resolves at most the 272. The majority are collisions
*inside* value space: `ts:v4/classic/schemas.ts:email` is both a `function` and
a `method`, and 116 cases pair a `parameter` with a `property`. No
declaration-space scheme separates those. They are an **owner-qualification
gap** — `ownerName()` returns null for members of anonymous type literals and
object literals, so those members get unqualified names.

- **Within value space (438):** qualify by lexical scope, not only by owning
  class or interface. A parameter of `f` becomes `ts:<file>:f.<param>`. This is
  the larger fix and it was missed.
- **Cross-space (272):** genuine TypeScript declaration merges — 247 are the
  `interface X` + `const X` pattern this corpus uses pervasively. **One
  TypeScript symbol is one entity**, so these keep one id and carry multiple
  declaration facts.

**3. Content hashes are facts about an entity, not its identity.** `contentId`
and `structureId` remain as fields on declaration facts, for cross-version
rename and move detection, gated on a minimum body size. They are inputs to a
matcher, never keys.

**4. Every extraction run asserts its own invariants and fails the run.** Two
are defined now:
- *Closure*: every edge endpoint names a declared entity or is explicitly
  unresolved with confidence ≤ 0.3. Enforced; exits non-zero.
- *Unambiguous identity*: one entity id names one entity, where merged
  declarations of a single TypeScript symbol count as one entity. The current
  check approximates this as "one id, one entityType", which over-reports — it
  flags all 272 cross-space merges that decision 2 holds to be correct.
  Reported, not enforced; enforceable once scope qualification lands and the
  check is restated per-symbol.

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
| Content-addressed ids (thesis §4.4) | Survives rename and move; no path coupling | 55.3% of entities in a colliding id; 49 distinct false-continuity events in one commit; 6.5% silent aliasing on body edits; breaks on every body edit, the dominant change mode | Fails silently on the common case to survive the rare one |
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
every member and parameter id, which is most of the fact base. Per-occurrence references grow the fact base ~52%.

**Unresolved, and deliberately out of scope.**
- **Anonymous `export default` has no entity id.** This is a schema gap, not an
  implementation gap: 11 of the 12 remaining flagged imports and 3 unresolved
  calls trace to it. It needs an id form before V1.
- **Query substrate → ADR-0002.** thesis §7.3 calls Datalog the
  highest-reward decision in the project. This ADR deliberately does not decide
  it: the fact base is defined independently of what queries it.
- **Cross-language identity.** The `ts:` prefix is a TypeScript scheme.
  decisions.md open tension #2 is untouched.
- **Correctness beyond closure.** Closure proves endpoints exist, not that
  edges are right. No oracle for edge correctness exists.
- **Incrementality.** thesis §4.2 claims it "falls out naturally". There is no
  incremental run, and the fact that any schema change invalidates every cached
  fact base suggests it will not fall out of anything by itself.

## Validation

The evidence is one corpus, one language, one library — and a type-heavy one
that never moves files. A service codebase would likely show moves, which this
corpus cannot test at all. Decision 2 is the one most exposed to that: if moves
turn out to be common elsewhere, the trade it makes is wrong, and it should be
revisited against a corpus that has them rather than defended.
