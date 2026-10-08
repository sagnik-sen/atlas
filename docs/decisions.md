# Session Decisions

Record of decisions and open questions from the founding engineering session (2026-07-25). This document serves as continuity for future sessions that won't have the original conversation context.

## Resolved

- **License**: Apache 2.0.
- **Language**: TypeScript for V1 implementation (strongly implied — explicitly confirm in ADR-0001).
- **Repo structure**: `docs/` only at this stage. No `src/`, `packages/`, or language directories until ADR-0001 defines the graph model.
- **Contribution model**: Design-first. No code contributions accepted until core architecture is defined.

## V1 Scope

Only static structural graph extraction from source code:

- Module/package structure
- Imports
- Declarations (classes, functions, interfaces)
- Containment and call relationships
- Single language first (TypeScript)
- No runtime/observability data
- No infrastructure modeling
- No multi-service tracing
- No visualization/UI
- No AI-native query interface

## Open Tensions

These need debate before ADR-0001 is finalized:

1. **Graph-first vs. IDE integration.** Vision says graph is primary, but developers won't leave their editor. Likely answer: an LSP-like protocol for in-editor graph queries with deeper exploration in a separate interface. Undecided.

2. **Language model universality.** How much of the node/edge model is universal vs. language-specific? Rust traits, Go embedding, TypeScript structural typing don't map 1:1. Lean: universal core with typed extension slots. Needs debate.

3. **Correctness verification.** If the graph is wrong, everything downstream is wrong. How do we prove extraction correctness? Not urgent for V1 but hardest quality problem. Should be explored early.

## Recommended Next Milestone (superseded 2026-08-21)

~~Write ADR-0001: Graph Model Definition...~~ This is dead. It assumed the graph was the primary abstraction; [docs/thesis.md](thesis.md) (2026-07-29) argued that's wrong and a fact-based multi-lens index is the right model, and the throwaway prototype in `prototype/` validated that argument empirically rather than waiting for an ADR. See thesis.md §7 for the recommendations that replaced this milestone (build the fact engine first, adopt Datalog, define the symbol identity layer) and [prototype/report.md](../prototype/report.md) for results, including a 2026-08-21 correction that raised measured call-graph resolution from 16.6% to 96.6% by fixing a bug in the prototype extractor (method calls were never attempted, not attempted-and-failed).

~~**Actual next milestone:** decide whether to harden the prototype extractor into a real V1...~~ Resolved 2026-08-26: the fork dissolved. Referential integrity was what both branches needed first, and answering it *was* schema work. See [prototype/report.md](../prototype/report.md) "Update (2026-08-26)".

## Where things stand (2026-08-26)

The prototype's call graph was measured at 16.8% edge closure — 83% of resolved edges named entities the fact base did not declare. That is now 97.0% with zero dangling endpoints, and the invariant ("every edge endpoint is declared or explicitly unresolved") is asserted on every extraction run, exiting non-zero on violation. This is the first mechanically checkable property the extractor asserts about itself, which open tension #3 below had been waiting for since the founding session. It is a weak form of correctness: it proves every edge endpoint names a declared entity, not that the edge is right. Entity-id ambiguity is reported but not enforced.

The `accidental dependency` heuristic flagged 100% of its input (345 of 345); it now flags 113 of 240 value imports (47.1%). Note 47.1% is the share still flagged, not a false-positive rate — the earlier 100% was entirely artifact, whereas the residue appears to be largely genuine signal about imports used as values rather than called. How much of it is genuine has not been measured, only sampled.

**Next milestone: ADR-0001, scoped to the fact schema.** There is now real data to ground it in, and the open questions are specific rather than architectural taste:

1. **Do non-entity call sites get facts, or get dropped?** Currently a call with no callable ancestor is attributed to its module. That is defensible but it makes "module" both a container and a caller.
2. **What namespace do external entities live in, and how stable is it?** `external:<origin>:<name>` works, but `origin` is derived from a path, so a dependency moving inside node_modules changes ids. tsconfig `paths` aliases that point back into the repo are currently misclassified as external (marked `ponytail:` in extract.ts).
3. **Does the fact base enforce closure at write time, or record violations as facts?** thesis.md §5.3 argues contradictions should themselves be facts. The current check does neither — it fails the run.
4. **Do we need reference facts?** Distinguishing "imported and called" from "imported and used" requires resolving every identifier occurrence, not just call expressions. This is the remaining 47.1%, and it is a materially larger fact base.
5. **Symbol identity is still path-and-name based** (`ts:<file>:<Owner.name>`), which thesis.md §4.4 says is the wrong foundation, and it demonstrably collides: **710 of 9,467 entity ids (7.5%) carry more than one entityType.** Owner qualification fixed collisions between class members and did nothing for collisions across declaration spaces — a type alias and a class property both named `output` in one module share an id today. Some of the 710 are TypeScript declaration merging, where sharing an id is arguably correct; `idOfNode()` cannot tell the two cases apart. The extractor reports this without enforcing it. Still the highest-risk assumption in the project, now with a number attached.

6. **What is in scope?** Resolution can land outside the walked file set — `v3/benchmarks/primitives.ts` instantiates `Mocker` from the excluded `tests/` tree. Such entities are currently declared as `out_of_scope` so closure holds. Does the fact base model only what it walked, or everything it can reach?
