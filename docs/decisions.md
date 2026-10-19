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

3. **Correctness verification. Partly answered.** Two invariants are now asserted on every extraction run and exit non-zero on violation: closure (every edge endpoint is a declared entity or explicitly unresolved) and unambiguous identity (no id names two entities within one declaration space). Both reached zero violations on 2026-10-09. Neither proves an edge is *correct*: `installLazyProps`'s `props()` yields a closed, confidence-0.9 edge terminating at a parameter with no body. Original note follows.

   **Correctness verification.** If the graph is wrong, everything downstream is wrong. How do we prove extraction correctness? Not urgent for V1 but hardest quality problem. Should be explored early.

## Recommended Next Milestone (superseded 2026-08-21)

~~Write ADR-0001: Graph Model Definition...~~ This is dead. It assumed the graph was the primary abstraction; [docs/thesis.md](thesis.md) (2026-07-29) argued that's wrong and a fact-based multi-lens index is the right model, and the throwaway prototype in `prototype/` validated that argument empirically rather than waiting for an ADR. See thesis.md §7 for the recommendations that replaced this milestone (build the fact engine first, adopt Datalog, define the symbol identity layer) and [prototype/report.md](../prototype/report.md) for results, including a 2026-08-21 correction that raised measured call-graph resolution from 16.6% to 96.6% by fixing a bug in the prototype extractor (method calls were never attempted, not attempted-and-failed).

~~**Actual next milestone:** decide whether to harden the prototype extractor into a real V1...~~ Resolved 2026-08-26: the fork dissolved. Referential integrity was what both branches needed first, and answering it *was* schema work. See [prototype/report.md](../prototype/report.md) "Update (2026-08-26)".

## Where things stand (2026-08-26)

The prototype's call graph was measured at 16.8% edge closure — 83% of resolved edges named entities the fact base did not declare. That is now 97.9% with zero dangling endpoints, and the invariant ("every edge endpoint is declared or explicitly unresolved") is asserted on every extraction run, exiting non-zero on violation. This is the first mechanically checkable property the extractor asserts about itself, which open tension #3 below had been waiting for since the founding session. It is a weak form of correctness: it proves every edge endpoint names a declared entity, not that the edge is right. Unambiguous identity is the second enforced invariant: within-space id collisions reached 0 in `90ffe38` and a nonzero count now fails the run.

The `accidental dependency` heuristic flagged 100% of its input (345 of 345). It now flags **12 of 148 value imports (8.1%)**, and the 113/240 figure recorded earlier reproduces only at commit `55f28bf`.

The 113 has since been decomposed, and the guess recorded here — that the residue was "largely genuine signal about imports used as values" — was wrong:

| Part of the 113 | Count | What it was |
|---|---|---|
| Extractor bug | **86** | `mkImport` hardcoded `importType: "namespace"`, ignoring `isTypeOnly()`, and ignored the per-specifier `type` modifier in `import { type X, Y }`. 94 such statements in the corpus. A two-line fix. |
| Genuinely needed reference facts | 15 | imports used as values, never called |
| Identity-layer gaps | 12 | 11 imports of an anonymous `export default`, which has no entity id, plus the `out_of_scope` `Mocker` |
| **Genuinely unused imports** | **0** | |

That makes four separate artifacts found in this one heuristic — the key-namespace mismatch, barrel indirection, dropped module-level callers, and now import-type misclassification. Each previous diagnosis attributed the residue to something real about static analysis. None of them were. It also means the report.md stage row "exclude type-only imports: 138/240" was under-excluding.

**ADR-0001 is written** ([docs/architecture/0001-fact-schema.md](architecture/0001-fact-schema.md), Status: Proposed, 2026-10-09). It decides identity, invariants, uncertainty, scope and edge kinds against measurement. The questions below are what it answers or explicitly defers:

1. **Do non-entity call sites get facts, or get dropped?** Currently a call with no callable ancestor is attributed to its module. That is defensible but it makes "module" both a container and a caller.
2. **What namespace do external entities live in, and how stable is it?** `external:<origin>:<name>` works, but `origin` is derived from a path, so a dependency moving inside node_modules changes ids. Bare specifiers that point back into the repo were misclassified as external. This was recorded as a tsconfig `paths` problem, but zod uses no `paths`: `zod/v3` resolves through its own package.json `exports` and the `@zod/source` custom condition. The extractor now asks the compiler to resolve bare specifiers, so the six `zod/v3` imports name `v3/index.ts`. Only genuinely external packages stay `external:`.
3. **Does the fact base enforce closure at write time, or record violations as facts?** thesis.md §5.3 argues contradictions should themselves be facts. The current check does neither — it fails the run.
4. **Do we need reference facts?** Distinguishing "imported and called" from "imported and used" requires resolving every identifier occurrence, not just call expressions. This is the remaining 47.1%, and it is a materially larger fact base.
5. **Symbol identity is path-and-name based, scope-qualified, with slot-keyed anonymous segments.** ADR-0001 decided against content addressing after measurement. A structure-only hash puts 60.1% of entities in a colliding id. Over Zod's full history (297 commit pairs), 48% of unchanged observations carry a hash shared with another entity. A body edit lands on a hash some other entity already holds 6.0% of the time, but only 0.80% where the old hash was unique, with 4 clear transfers of identity. The change mix decides the trade: 2,113 body edits across 247 commits, against 5 independent rename events and zero moves. Ids carry a lexical scope path. Within-space collisions are 0 and enforced, and the 270 cross-space pairs are TypeScript declaration merges, correct by design. What actually breaks `entityId` across history is not renames. It is owner moves: 154 entities in 13 commits, 111 of them from two Zod refactors that moved its method objects. Residual positional drift adds 80 in 27 commits, down from 140 once anonymous segments were keyed on their syntactic slot. An earlier "263 (98%) positional drift" figure was a harness mislabel. Both kinds of break are visible failures, the trade ADR-0001 chose over silent ones. Every anonymous function is an entity too (`anonymous-function`, carrying the `ownerId` its static calls are attributed to), which takes the exact runtime join from 34.4% to 92.7% and meets the first of ADR-0001's three preconditions for runtime ingestion. The other two are open.

6. **What is in scope?** Resolution can land outside the walked file set — `v3/benchmarks/primitives.ts` instantiates `Mocker` from the excluded `tests/` tree. Such entities are currently declared as `out_of_scope` so closure holds. Does the fact base model only what it walked, or everything it can reach?
