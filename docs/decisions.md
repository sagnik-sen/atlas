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

## Recommended Next Milestone

**Write ADR-0001: Graph Model Definition.** Define exact node types, edge types, property schemas, and query model. Include concrete mapping examples (e.g., a TypeScript Express app mapped to the graph). Debate thoroughly before any code.

After ADR-0001: ADR-0002 (graph storage/query engine), then prototype extractor for a single language.
